import type { ConnectionKind } from '../src/shared/roomConnection';
import type { ConnectionSnapshot } from '../src/shared/contracts';

export interface ConnectionMetadata {
  kind: ConnectionKind;
  /** The room this socket is watching. */
  roomId: string;
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

  /** Every room somebody has a socket open on. */
  roomIds(): Set<string> {
    return new Set([...this.connections.values()].map((connection) => connection.roomId));
  }

  *clientsInRoom(roomId: string): Generator<Client> {
    for (const [client, connection] of this.connections) {
      if (connection.roomId === roomId) yield client;
    }
  }

  countOfKind(kind: ConnectionKind): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.kind === kind) count += 1;
    }
    return count;
  }

  /** People in one room, or across every room when none is named. */
  listenerCount(roomId?: string): number {
    const listeners = new Set<Client | string>();

    for (const [client, connection] of this.connections) {
      if (connection.kind !== 'room') continue;
      if (roomId !== undefined && connection.roomId !== roomId) continue;
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

  /** Signed-in people in one room, who are the ones a skip ratio counts, or across every room. */
  eligibleVoterCount(roomId?: string): number {
    const users = new Set<string>();

    for (const connection of this.connections.values()) {
      if (connection.kind === 'room' &&
        (roomId === undefined || connection.roomId === roomId) &&
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
