/**
 * Curated keyword -> glyph table.
 *
 * Deliberately small and hand-picked. The look depends on glyphs being RARE:
 * a glyph on every line reads as clip-art, one every few lines reads as design.
 * Keys are lemmatised stems, matched after the crude stemmer in mapper.ts.
 */
export const GLYPH_MAP: Record<string, string> = {
  // sight / attention
  see: '\u{1F441}\u{FE0F}', look: '\u{1F440}', eye: '\u{1F441}\u{FE0F}', watch: '\u{1F440}',
  blind: '\u{1F576}\u{FE0F}', stare: '\u{1F440}', vision: '\u{1F441}\u{FE0F}',
  // speech / sound
  tell: '\u{1F4AC}', say: '\u{1F4AC}', talk: '\u{1F4AC}', speak: '\u{1F4AC}', word: '\u{1F4AC}',
  call: '\u{1F4DE}', phone: '\u{1F4F1}', scream: '\u{1F4E2}', shout: '\u{1F4E2}', whisper: '\u{1F92B}',
  sing: '\u{1F3A4}', song: '\u{1F3B5}', music: '\u{1F3B6}', radio: '\u{1F4FB}', voice: '\u{1F3A4}',
  // emotion
  love: '\u{2764}\u{FE0F}', heart: '\u{1F496}', cry: '\u{1F4A7}', tear: '\u{1F4A7}',
  smile: '\u{1F642}', laugh: '\u{1F602}', pain: '\u{1F494}', broke: '\u{1F494}', hurt: '\u{1F494}',
  lonely: '\u{1F30C}', alone: '\u{1F30C}', miss: '\u{1F494}',
  // elements / weather
  fire: '\u{1F525}', burn: '\u{1F525}', flame: '\u{1F525}', hot: '\u{1F525}',
  ice: '\u{1F9CA}', cold: '\u{2744}\u{FE0F}', snow: '\u{2744}\u{FE0F}', freeze: '\u{1F9CA}',
  rain: '\u{1F327}\u{FE0F}', storm: '\u{26C8}\u{FE0F}', thunder: '\u{26A1}', lightning: '\u{26A1}',
  wind: '\u{1F343}', cloud: '\u{2601}\u{FE0F}', sun: '\u{2600}\u{FE0F}', moon: '\u{1F319}',
  star: '\u{2B50}', sky: '\u{1F30C}', night: '\u{1F319}', dark: '\u{1F311}', light: '\u{1F4A1}',
  water: '\u{1F30A}', ocean: '\u{1F30A}', sea: '\u{1F30A}', wave: '\u{1F30A}', river: '\u{1F30A}',
  // money / status
  money: '\u{1F4B0}', cash: '\u{1F4B5}', rich: '\u{1F4B0}', bank: '\u{1F3E6}', dollar: '\u{1F4B5}',
  gold: '\u{1F947}', diamond: '\u{1F48E}', ice_jewel: '\u{1F48E}', chain: '\u{26D3}\u{FE0F}',
  crown: '\u{1F451}', king: '\u{1F451}', queen: '\u{1F451}', win: '\u{1F3C6}', trophy: '\u{1F3C6}',
  boss: '\u{1F454}',
  // movement / places
  road: '\u{1F6E3}\u{FE0F}', drive: '\u{1F697}', car: '\u{1F697}', ride: '\u{1F3CD}\u{FE0F}',
  run: '\u{1F3C3}', walk: '\u{1F6B6}', fly: '\u{1F6EB}', plane: '\u{2708}\u{FE0F}', jet: '\u{2708}\u{FE0F}',
  home: '\u{1F3E0}', house: '\u{1F3E0}', door: '\u{1F6AA}', city: '\u{1F303}', street: '\u{1F303}',
  map: '\u{1F5FA}\u{FE0F}', lost: '\u{1F9ED}', paradise: '\u{1F3DD}\u{FE0F}', beach: '\u{1F3D6}\u{FE0F}',
  // time
  time: '\u{23F1}\u{FE0F}', clock: '\u{1F553}', forever: '\u{267E}\u{FE0F}', never: '\u{1F6AB}',
  tomorrow: '\u{1F305}', yesterday: '\u{1F553}', summer: '\u{2600}\u{FE0F}', winter: '\u{2744}\u{FE0F}',
  // body / life
  hand: '\u{1F91A}', head: '\u{1F9E0}', mind: '\u{1F9E0}', brain: '\u{1F9E0}', soul: '\u{1F54A}\u{FE0F}',
  blood: '\u{1FA78}', bone: '\u{1F9B4}', skin: '\u{1FAF6}', face: '\u{1F610}', smoke: '\u{1F4A8}',
  // nature
  rose: '\u{1F339}', flower: '\u{1F338}', tree: '\u{1F333}', green: '\u{1F343}', leaf: '\u{1F343}',
  // conflict
  fight: '\u{1F94A}', war: '\u{2694}\u{FE0F}', gun: '\u{1F3AF}', knife: '\u{1F52A}', enemy: '\u{1F3AF}',
  // misc high-frequency lyric nouns
  dream: '\u{1F4AD}', sleep: '\u{1F634}', wake: '\u{23F0}', drug: '\u{1F48A}', pill: '\u{1F48A}',
  drink: '\u{1F943}', wine: '\u{1F377}', party: '\u{1F389}', dance: '\u{1F57A}', club: '\u{1F3B6}',
  key: '\u{1F511}', lock: '\u{1F512}', ghost: '\u{1F47B}', angel: '\u{1F607}', devil: '\u{1F608}',
  god: '\u{1F64F}', pray: '\u{1F64F}', church: '\u{26EA}', heaven: '\u{2601}\u{FE0F}', hell: '\u{1F525}',
  magic: '\u{2728}', shine: '\u{2728}', glow: '\u{2728}', bright: '\u{2728}',
  camera: '\u{1F4F7}', picture: '\u{1F5BC}\u{FE0F}', photo: '\u{1F4F7}', screen: '\u{1F4FA}',
  train: '\u{1F686}', boat: '\u{26F5}', bike: '\u{1F6B2}', rocket: '\u{1F680}', space: '\u{1F30C}',
  bird: '\u{1F426}', wolf: '\u{1F43A}', snake: '\u{1F40D}', lion: '\u{1F981}', dog: '\u{1F415}',
};

/** Words that must never trigger a glyph, however often they appear. */
export const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','than','so','as','at','by','for','from','in','into',
  'of','on','to','with','up','down','out','off','over','under','again','once','here','there','when',
  'where','why','how','all','any','both','each','few','more','most','other','some','such','no','nor',
  'not','only','own','same','too','very','can','will','just','don','should','now','i','me','my','we',
  'us','our','you','your','he','him','his','she','her','it','its','they','them','their','what','which',
  'who','whom','this','that','these','those','am','is','are','was','were','be','been','being','have',
  'has','had','do','does','did','doing','would','could','ain','got','get','gonna','wanna','yeah','oh',
  'uh','ah','na','la','em','ya','like','know','go','come','make','take','let','put','keep','give',
]);
