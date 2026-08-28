/**
 * Integration tests truncate tables between cases, so they must never point at
 * a database anyone cares about. Requiring the name to end in `_test` is the
 * cheap guard: aiming them at the development database once was enough to wipe
 * a live room's users and history.
 */
export function testConnectionString(): string | undefined {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return undefined;

  const database = new URL(url).pathname.replace(/^\//, '');
  if (!database.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL points at "${database}", which these tests would truncate. ` +
        'Use a database whose name ends in _test.',
    );
  }
  return url;
}
