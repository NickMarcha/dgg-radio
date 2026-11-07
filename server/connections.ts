import type { ConnectionKind } from '../src/shared/stationConnection';
import type { ConnectionSnapshot } from '../src/shared/contracts';

export interface ConnectionMetadata {
  kind: ConnectionKind;
  /** The station this socket is watching. */
  stationId: string;
  userId: string | null;
  username: string | null;
  visitorId: string | null;
}

export class ConnectionRegistry<Client> {
  private readonly connections = new Map<
    Client,
    ConnectionMetadata & { connectedAt: Date }
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(client: Client, metadata: ConnectionMetadata): void {
    this.connections.set(client, { ...metadata, connectedAt: this.now() });
  }

  delete(client: Client): boolean {
    return this.connections.delete(client);
  }

  clients(): IterableIterator<Client> {
    return this.connections.keys();
  }

  /** The clients of one kind, for a broadcast only they should receive. */
  *clientsOfKind(kind: ConnectionKind): Generator<Client> {
    for (const [client, connection] of this.connections) {
      if (connection.kind === kind) yield client;
    }
  }

  stationOf(client: Client): string | undefined {
    return this.connections.get(client)?.stationId;
  }

  /** Every station somebody has a socket open on. */
  stationIds(): Set<string> {
    return new Set([...this.connections.values()].map((connection) => connection.stationId));
  }

  *clientsInStation(stationId: string): Generator<Client> {
    for (const [client, connection] of this.connections) {
      if (connection.stationId === stationId) yield client;
    }
  }

  countOfKind(kind: ConnectionKind): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.kind === kind) count += 1;
    }
    return count;
  }

  /** People in one station, or across every station when none is named. */
  listenerCount(stationId?: string): number {
    const listeners = new Set<Client | string>();

    for (const [client, connection] of this.connections) {
      if (connection.kind !== 'station') continue;
      if (stationId !== undefined && connection.stationId !== stationId) continue;
      if (connection.userId) {
        listeners.add(`user:${connection.userId}`);
      } else if (connection.visitorId) {
        listeners.add(`visitor:${connection.visitorId}`);
      } else {
        listeners.add(client);
      }
    }

    return listeners.size;
  }

  /** Signed-in people in one station, who are the ones a skip ratio counts, or across every station. */
  eligibleVoterCount(stationId?: string): number {
    const users = new Set<string>();

    for (const connection of this.connections.values()) {
      if (connection.kind === 'station' &&
        (stationId === undefined || connection.stationId === stationId) &&
        connection.userId) {
        users.add(connection.userId);
      }
    }

    return users.size;
  }

  snapshot(): ConnectionSnapshot {
    return {
      socketCount: this.connections.size,
      listenerCount: this.listenerCount(),
      eligibleVoterCount: this.eligibleVoterCount(),
      connections: [...this.connections.values()].map((connection) => ({
        kind: connection.kind,
        username: connection.username,
        connectedAt: connection.connectedAt.toISOString(),
      })),
    };
  }
}
