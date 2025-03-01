import fs from 'fs';
import {Veritas, SpaceOut} from '@spacesprotocol/veritas';
import b4a from 'b4a';

interface Anchor {
    root: string;
    block: {
        hash: string;
        height: number;
    };
}

export interface Receipt {
    proofSeq: number,
    root: Uint8Array,
    spaceout: SpaceOut,
}

interface SyncOptions {
    localPath?: string;        // Local file
    remoteUrls?: string[];     // Optional remote endpoints to fetch anchor file
    staticAnchors?: Anchor[];   // Optional use the following static anchors instead
    checkIntervalMs?: number;  // Periodic refresh
}

export class VeritasSync {
  private veritas: Veritas;
  private versionIndex: Map<string, number>;
  private fileWatcher: fs.FSWatcher | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private destroyed = false; // Flag to stop retry loop

  // A block height/version number where proofs below are considered stale
  private staleThreshold: number = 0;

  public static async create(options: SyncOptions): Promise<VeritasSync> {
    const obj = new VeritasSync(options);
    if (!options.staticAnchors) {
      await obj.refreshAnchors(true);
    }
    return obj;
  }

  private constructor(private options: SyncOptions) {
    const usingLocal = !!options.localPath;
    const usingRemote = !!options.remoteUrls;
    const usingStaticAnchors = !!options.staticAnchors;

    if ([usingLocal, usingRemote, usingStaticAnchors].filter(Boolean).length != 1) {
      throw new Error('Must specify exactly one of local, remote, or static anchors.');
    }

    this.veritas = new Veritas();
    this.versionIndex = new Map();

    if (options.staticAnchors) {
      this.updateAnchors(options.staticAnchors);
    }

    if (usingLocal) {
      this.fileWatcher = fs.watch(this.options.localPath!, (eventType) => {
        if (eventType === 'change') {
          this.refreshAnchors().catch(err => {
            console.error(`Error refreshing anchors on file change: ${err}`);
          });
        }
      });
    }

    if (!usingStaticAnchors) {
      const defaultCheckInterval = 10 * 60000;
      const interval = this.options.checkIntervalMs ?? defaultCheckInterval;
      this.intervalId = setInterval(() => {
        this.refreshAnchors().catch(err => {
          console.error(`Error during periodic refresh: ${err}`);
        });
      }, interval);
    }
  }

  public getProofSeq(root: Uint8Array): number | undefined {
    return this.versionIndex.get(b4a.toString(root, 'hex'))
  }

  public verifyPut(
    target: Uint8Array,
    msg: Uint8Array,
    signature: Uint8Array,
    proof: Uint8Array
  ): Receipt {
    const subtree = this.veritas.verifyProof(proof);
    const spaceout = subtree.findSpace(target);
    if (!spaceout) {
      throw new Error('No UTXO associated with target');
    }

    this.veritas.verifyMessage(spaceout, msg, signature);
    const root = subtree.getRoot();
    const rootKey = b4a.toString(subtree.getRoot(), 'hex');
    const proofSeq = this.versionIndex.get(rootKey);
    if (!proofSeq) {
      throw new Error('Could not find proof version');
    }

    return {
      proofSeq,
      root,
      spaceout
    };
  }

  public destroy(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.destroyed = true;
  }

  private async refreshAnchors(isInitial: boolean = false): Promise<void> {
    if (this.options.localPath) {
      try {
        const data = fs.readFileSync(this.options.localPath, 'utf8');
        const anchors: Anchor[] = JSON.parse(data);
        this.updateAnchors(anchors);
        return;
      } catch (err) {
        console.error(`Failed to read or parse local anchors file: ${err}`);
      }
    }

    if (!this.options.remoteUrls) {
      throw new Error('Expected either local or remote anchors option set');
    }

    const maxRetries = isInitial ? 1 : Infinity;
    const anchors = await this.tryFetchAnchors(maxRetries, 5000);
    if (isInitial && !anchors) {
      this.destroy();
      throw new Error('A valid anchors source is required');
    }

    if (anchors) {
      this.updateAnchors(anchors);
    }
  }

  private async tryFetchAnchors(maxRetries: number, delayMs: number): Promise<Anchor[] | null> {
    let attempts = 0;
    while (!this.destroyed && (maxRetries === Infinity || attempts < maxRetries)) {
      try {
        return await this.fetchAnchorsFromRemotes(this.options.remoteUrls!);
      } catch (err) {
        attempts++;
        console.error(`${err}.` + (attempts < maxRetries ? ` Retrying in ${delayMs}ms...` : ''));
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private async fetchAnchorsFromRemotes(remoteUrls: string[]): Promise<Anchor[]> {
    const responses = await Promise.all(
      remoteUrls.map(async url => {
        console.log(`Fetching anchors from: ${url}`);
        try {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`Status: ${res.status}`);
          }
          return res.json();
        } catch (err) {
          console.error(`Error fetching ${url}: ${err}`);
          return null;
        }
      })
    );

    const validResponses = responses.filter((res): res is Anchor[] => res !== null);
    if (validResponses.length === 0) {
      throw new Error('No valid remote anchors found');
    }

    const groups = new Map<string, { count: number; anchors: Anchor[] }>();
    for (const anchors of validResponses) {
      if (!anchors.length) continue;
      const key = anchors[0].root;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, {count: 1, anchors});
      } else {
        group.count++;
      }
    }

    // Choose the group with the highest matches.
    // In case of a tie, pick the one whose first anchor has the highest block height.
    let chosen: { count: number; anchors: Anchor[] } | null = null;
    for (const group of groups.values()) {
      if (
        !chosen ||
                group.count > chosen.count ||
                (group.count === chosen.count &&
                    group.anchors[0].block.height > chosen.anchors[0].block.height)
      ) {
        chosen = group;
      }
    }
    if (!chosen) {
      throw new Error('No anchors selected');
    }
    return chosen.anchors;
  }

  public isStale(version: number): boolean {
    return version < this.staleThreshold;
  }

  private updateAnchors(anchors: Anchor[]) {
    this.veritas = new Veritas();
    this.versionIndex = new Map();

    if (anchors.length === 0) {
      return;
    }

    // Sort anchors descending by block height (most recent first)
    anchors.sort((a, b) => b.block.height - a.block.height);

    // Set stale threshold: if more than 8 anchors, the threshold is the block height of the 9th oldest.
    this.staleThreshold = anchors.length > 9 ? anchors[anchors.length - 9].block.height : 0;

    for (const anchor of anchors) {
      const root = Buffer.from(anchor.root, 'hex');
      this.veritas.addAnchor(root);
      this.versionIndex.set(anchor.root, anchor.block.height);
    }

    console.log(`Anchors refreshed, latest block ${anchors[0].block.height}`);
  }
}
