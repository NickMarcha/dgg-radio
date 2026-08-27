export const roomRules = [
  'No meme songs unless a moderator or broadcaster says otherwise. If asked, change your request. A violation can mean a one-week ban.',
  'No Disney songs.',
  'Use your DGG identity. The radio signs you in through Destiny, so moderators always know whose request is playing.',
  'Link the song itself as it appears on the album. Avoid music videos with long intros or outros and scenes from television or film unless the song is unique to that work.',
  'Do not spam sexual or otherwise inappropriate media around the room.',
] as const;

export const allowedExamples = [
  'Weird Al',
  '100 gecs, Death Grips, and other abrasive or experimental music',
  'Nerdcore',
  'Music you produced',
  'Music from composition challenges',
  'Neil Cicierega',
  'Music by friends of Destiny that is not about him',
] as const;

export const blockedExamples = [
  'Dicko Mode, The Glob, Thick of It, Big Booty Bitches, and Chocolate Rain',
  "Destiny's rap battles, whether real or AI-generated",
  'Thomas the Tank Engine hip-hop remixes and anime or rap mashups',
  'Tracks that trigger excessive chat spam',
  'Humorous or offensive music about race, except White & Nerdy',
  'Music by enemies, exes, or former friends of Destiny',
] as const;
