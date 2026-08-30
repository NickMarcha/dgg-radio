import type { ConnectionKind } from '../src/shared/roomConnection';
import type { ConnectionSnapshot } from '../src/shared/contracts';

export interface ConnectionMetadata {
  kind: ConnectionKind;
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

  listenerCount(): number {
    const listeners = new Set<Client | string>();

    for (const [client, connection] of this.connections) {
      if (connection.kind !== 'room') continue;
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

  eligibleVoterCount(): number {
    const users = new Set<string>();

    for (const connection of this.connections.values()) {
      if (connection.kind === 'room' && connection.userId) users.add(connection.userId);
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
