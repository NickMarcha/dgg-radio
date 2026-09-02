/**
 * Exports your own QueUp playlists to a JSON file you can import into DGG Radio.
 *
 * Playlists are private, so unlike the room's history they cannot be read from
 * outside: the API answers them only for the browser holding your QueUp login
 * cookie, and only when the request comes from queup.net itself. That makes a
 * pasted snippet the whole workflow.
 *
 * 1. Open https://queup.net and sign in.
 * 2. Open the browser console: F12, or Ctrl+Shift+J (Cmd+Option+J on a Mac).
 * 3. Paste this whole file in and press Enter. Chrome may ask you to type
 *    "allow pasting" first; that warning is worth reading, and this file is
 *    worth reading before you trust it.
 * 4. It saves `queup-playlists.json` to your downloads. Import that file on the
 *    DGG Radio playlists page.
 *
 * It only reads. Nothing here writes to, renames, or deletes anything on QueUp.
 */

(async () => {
  const API = 'https://api.queup.net';
  /** Both playlist endpoints answer 20 rows a page and say "no more" by answering fewer. */
  const PAGE_SIZE = 20;

  if (location.origin !== 'https://queup.net') {
    console.error('Run this on https://queup.net — the API refuses your session from anywhere else.');
    return;
  }

  const get = async (path) => {
    const response = await fetch(API + path, { credentials: 'include' });
    // Signed out, the API redirects every private endpoint to its login page,
    // so an HTML answer here means the session is the problem, not the data.
    if (response.redirected || !response.headers.get('content-type')?.includes('json')) {
      throw new Error('QueUp did not recognise your session. Sign in at queup.net and run this again.');
    }
    const body = await response.json();
    if (body.code !== 200) throw new Error(`${path} answered code ${body.code}: ${body.message}`);
    return body.data;
  };

  const track = (entry) => {
    const song = entry._song;
    if (!song?.fkid || !song.type) return null;
    return {
      provider: song.type,
      // A YouTube video id, or a numeric SoundCloud track id.
      providerMediaId: song.fkid,
      songId: song._id,
      title: song.name,
      durationSeconds: Math.round((song.songLength ?? 0) / 1000),
      thumbnailUrl: song.images?.thumbnail ?? null,
      addedAt: entry.added ? new Date(entry.added).toISOString() : null,
    };
  };

  try {
    const me = await get('/auth/session');
    const playlists = await get('/playlist');
    console.log(`Signed in as ${me.username}. ${playlists.length} playlist(s) to read.`);

    const exported = [];
    for (const playlist of playlists) {
      const tracks = [];
      // Pages are offsets into a list you can edit in another tab, so the same
      // song can appear on two pages. Ids are kept to drop the repeat.
      const seen = new Set();
      let dropped = 0;
      for (let page = 1; ; page += 1) {
        const rows = await get(`/playlist/${playlist._id}/songs?name=&page=${page}`);
        for (const row of rows) {
          if (seen.has(row._id)) continue;
          seen.add(row._id);
          const parsed = track(row);
          if (parsed) tracks.push(parsed);
          else dropped += 1;
        }
        if (rows.length < PAGE_SIZE) break;
      }
      console.log(
        `  ${playlist.name}: ${tracks.length} of ${playlist.totalItems ?? tracks.length} tracks` +
          (dropped ? ` (${dropped} skipped: no longer on QueUp)` : ''),
      );
      exported.push({
        id: playlist._id,
        name: playlist.name,
        createdAt: playlist.created ? new Date(playlist.created).toISOString() : null,
        tracks,
      });
    }

    const file = {
      source: 'queup',
      kind: 'playlists',
      exportedAt: new Date().toISOString(),
      owner: { id: me._id, username: me.username },
      playlists: exported,
    };

    // Kept on the window as well, so `copy(queupExport)` is there if the
    // download is blocked or lands somewhere unhelpful.
    window.queupExport = file;
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'queup-playlists.json';
    link.click();
    URL.revokeObjectURL(url);

    const total = exported.reduce((sum, playlist) => sum + playlist.tracks.length, 0);
    console.log(
      `Saved queup-playlists.json — ${exported.length} playlist(s), ${total} tracks. ` +
        'Also available here as queupExport; run copy(queupExport) to put it on the clipboard.',
    );
  } catch (error) {
    console.error('Export failed:', error.message ?? error);
  }
})();
