// Named corridors (docs/V2-ROAD-GRAPH.md §2 `roads`): every real edge carries
// the roadId of the street that grew it, so a corridor is the ordered chain
// of edges sharing a roadId — one avenue running across the city, not the
// segments it happens to be made of. Names are deterministic per seed.

import { RNG } from './rng.js';
import { VIRTUAL } from './graph.js';

// Each pool keeps the existing stem + class suffix grammar, but gives the
// massing modes their own register.  The pools are deliberately larger than
// the corridor count of a dense city so the retry rule below remains useful
// without producing visible duplicates.
const NAME_POOLS = {
  mixed: [
    'Kaiser', 'Ring', 'Garten', 'Hafen', 'Bahnhof', 'Markt', 'Linden', 'Wall', 'Berg', 'Brücken',
    'Stern', 'Kanal', 'Turm', 'Park', 'Nord', 'Süd', 'Ost', 'West', 'Neu', 'Alt', 'Hoch', 'Schloss',
    'Münz', 'Rathaus', 'Friedrich', 'Wilhelm', 'Goethe', 'Schiller', 'Bismarck', 'Viktoria', 'König',
    'Kronen', 'Rosen', 'Eichen', 'Buchen', 'Ahorn', 'Birken', 'Wiesen', 'Sonnen', 'Blumen', 'Heide',
    'Wald', 'Hain', 'Ufer', 'Insel', 'Branden', 'Dresdner', 'Leipziger', 'Hamburger', 'Bremer',
    'Frankfurter', 'Mainzer', 'Kölner', 'Münchner', 'Berliner', 'Marien', 'Luisen', 'Augusten',
    'Charlotten', 'Sophien', 'Elisabeth', 'Gutenberg', 'Universitäts', 'Theater', 'Opern', 'Museums',
    'Kontor', 'Post', 'Feld', 'Bach', 'Mühlen', 'Schützen', 'Friedens', 'Freiheits', 'Europa', 'Gruben',
    'Zechen', 'Werk', 'Güter', 'Ziegel', 'Kiefern', 'Erlen', 'Feldmark', 'Morgen', 'Abend', 'Quellen',
    'Brunn', 'Bürger', 'Kultur', 'Werder', 'Aue', 'Flieder', 'Rosengarten', 'Pfauen', 'Kastanien',
    'Platanen', 'Schmiede', 'Weinberg', 'Stadt', 'Anker', 'Brunnen',
  ],
  core: [
    'Zentral', 'Haupt', 'City', 'Hoch', 'Bank', 'Börsen', 'Rathaus', 'König', 'Kronen', 'Kaiser',
    'Friedrich', 'Wilhelm', 'Alexander', 'Maximilian', 'Konrad', 'Leopold', 'Georg', 'August', 'Viktoria',
    'Charlotte', 'Louise', 'Marien', 'Opern', 'Theater', 'Museums', 'Universitäts', 'Regierungs',
    'Parlament', 'Palais', 'Residenz', 'Dom', 'Münster', 'Kathedral', 'Markt', 'Handels', 'Kontor',
    'Kauf', 'Gewerbe', 'Messe', 'Börse', 'Hauptbahnhof', 'Bahnhof', 'Post', 'Telegraph', 'Banken',
    'Geschäfts', 'Finanz', 'Kurfürsten', 'Prinzen', 'Königs', 'Fürsten', 'Pracht', 'Prunk', 'Gloria',
    'Triumph', 'Forum', 'Agora', 'Promenaden', 'Boulevard', 'Ring', 'Stern', 'Turm', 'Brücken', 'Adler',
    'Löwen', 'Anker', 'Europa', 'Einheit', 'Freiheit', 'Frieden', 'Republik', 'Concordia', 'Germania',
    'Bellevue', 'Linden', 'Platanen', 'Kastanien', 'Schiller', 'Goethe', 'Lessing', 'Kant', 'Humboldt',
    'Heine', 'Mozart', 'Beethoven', 'Schubert', 'Wagner', 'Wall', 'Tor', 'Wache', 'Kommandanten',
    'Zitadellen', 'Stadt', 'Reichs', 'Welt', 'Licht', 'Nacht',
  ],
  euro: [
    'Bismarck', 'Goethe', 'Schiller', 'Kant', 'Lessing', 'Humboldt', 'Heine', 'Fontane', 'Kleist',
    'Herder', 'Schopenhauer', 'Beethoven', 'Mozart', 'Schubert', 'Wagner', 'Brahms', 'Bach', 'Viktoria',
    'Wilhelm', 'Friedrich', 'August', 'Konrad', 'Maximilian', 'Leopold', 'Charlotten', 'Luisen', 'Marien',
    'Sophien', 'Elisabeth', 'Josephinen', 'Prinz', 'Kaiser', 'König', 'Kronen', 'Fürsten', 'Adel', 'Palais',
    'Bellevue', 'Residenz', 'Monbijou', 'Opern', 'Theater', 'Museums', 'Universitäts', 'Rathaus', 'Post',
    'Börsen', 'Handels', 'Kauf', 'Kontor', 'Promenaden', 'Esplanaden', 'Pariser', 'Französische',
    'Italienische', 'Brandenburger', 'Schloss', 'Dom', 'Neue', 'Alte', 'Große', 'Kleine', 'Lange', 'Breite',
    'Schöne', 'Platanen', 'Kastanien', 'Linden', 'Akazien', 'Rosen', 'Eichen', 'Ulmen', 'Ahorn', 'Birken',
    'Gärten', 'Park', 'Volksgarten', 'Stadtpark', 'Westend', 'Westfalen', 'Werder', 'Spree', 'Donau',
    'Rhein', 'Elbe', 'Main', 'Isar', 'Ufer', 'Brunnen', 'Friedens', 'Sieges', 'Einheits', 'Kultur',
    'Bürger', 'Zeughaus', 'Hansa', 'Gendarmen', 'Lützow', 'Reichs',
  ],
  lowrise: [
    'Garten', 'Gartenstadt', 'Heim', 'Heide', 'Wiese', 'Wiesen', 'Rosen', 'Blumen', 'Dahlien', 'Tulpen',
    'Veilchen', 'Flieder', 'Sonnen', 'Abend', 'Morgen', 'Frühlings', 'Sommer', 'Herbst', 'Winter', 'Birken',
    'Buchen', 'Eichen', 'Ahorn', 'Erlen', 'Eschen', 'Kiefern', 'Fichten', 'Lärchen', 'Linden', 'Ulmen',
    'Weiden', 'Hasel', 'Holunder', 'Kirsch', 'Apfel', 'Beeren', 'Farn', 'Moos', 'Hain', 'Wald', 'Waldrand',
    'Waldruh', 'Waldes', 'Flur', 'Feld', 'Feldmark', 'Aue', 'Bach', 'Quelle', 'Brunnen', 'Teich', 'Weiher',
    'Hügel', 'Hang', 'Grund', 'Lauben', 'Laubengang', 'Siedler', 'Familien', 'Nachbar', 'Frieden', 'Freude',
    'Sonntag', 'Feierabend', 'Heimat', 'Glück', 'Eintracht', 'Gemein', 'Gemeinde', 'Dorf', 'Vorwerk',
    'Anger', 'Hof', 'Land', 'Landhaus', 'Park', 'Kirschgarten', 'Obstgarten', 'Schreber', 'Kolonie',
    'Parzellen', 'Reihen', 'Alleen', 'Promenaden', 'Spazier', 'Spiel', 'Kinder', 'Schule', 'Sport', 'Vogel',
    'Amsel', 'Fink', 'Drossel', 'Meise', 'Lerchen', 'Schwalben', 'Hasen', 'Rehe', 'Igel', 'Biber', 'Fuchs',
    'Kuckuck', 'Pfauen', 'Blüten', 'Sonnenhof',
  ],
  industrial: [
    'Werk', 'Werks', 'Fabrik', 'Maschinen', 'Stahl', 'Eisen', 'Kupfer', 'Blei', 'Zink', 'Messing', 'Kohle',
    'Kohlen', 'Koks', 'Erz', 'Schlacke', 'Asche', 'Dampf', 'Kessel', 'Turbinen', 'Motoren', 'Generatoren',
    'Schalt', 'Walz', 'Schmiede', 'Gießerei', 'Schmelz', 'Hochofen', 'Ofen', 'Ziegel', 'Klinker', 'Beton',
    'Glas', 'Keramik', 'Textil', 'Spinn', 'Weberei', 'Gerberei', 'Mühlen', 'Sägewerk', 'Gruben', 'Zechen',
    'Schacht', 'Stollen', 'Förder', 'Verlade', 'Lade', 'Lager', 'Speicher', 'Depot', 'Magazin', 'Schuppen',
    'Hallen', 'Werft', 'Hafen', 'Osthafen', 'Westhafen', 'Nordhafen', 'Südhafen', 'Kai', 'Ufer', 'Kanal',
    'Güter', 'Güterbahnhof', 'Rangier', 'Waggon', 'Lokomotiv', 'Schienen', 'Gleis', 'Weichen', 'Signal',
    'Stellwerk', 'Brücken', 'Kran', 'Dock', 'Becken', 'Zoll', 'Spedition', 'Fracht', 'Last', 'Fuhr',
    'Zentrale', 'Anker', 'Strom', 'Kraft', 'Elektrik', 'Gas', 'Öl', 'Petrol', 'Diesel', 'Ammoniak', 'Chemie',
    'Phosphat', 'Draht', 'Rohr', 'Schrauben', 'Nieten', 'Schiff', 'Rohstoff', 'Umschlag', 'Produktions',
  ],
};

const SUFFIX = {
  arterial: ['allee', 'straße', 'ring', 'damm', 'ufer', 'chaussee', 'promenade'],
  collector: ['straße', 'weg', 'gasse', 'ufer', 'steig', 'damm', 'zeile'],
  local: ['gasse', 'weg', 'steig', 'pfad', 'zeile', 'winkel', 'allee'],
};

function corridorName(rng, stems, cls, used) {
  const suffixes = SUFFIX[cls] || SUFFIX.local;
  let name;
  for (let k = 0; k < 20; k++) {
    name = rng.pick(stems) + rng.pick(suffixes);
    if (!used.has(name)) break;
  }
  if (used.has(name)) {
    // Preserve the bounded retry semantics, then deterministically take the
    // first unused themed combination if a dense graph exhausts retries.
    for (const stem of stems) for (const suffix of suffixes) {
      const candidate = stem + suffix;
      if (!used.has(candidate)) return candidate;
    }
    // This is only reachable for an out-sized direct caller. Keep its base
    // vocabulary and make the public name unique without another RNG draw.
    name = `${name} ${used.size + 1}`;
  }
  return name;
}

export function buildCorridors(g, seed, massing = 'mixed') {
  const byRoad = new Map();
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    if (e.removed || VIRTUAL.has(e.cls) || e.roadId < 0) continue;
    if (!byRoad.has(e.roadId)) byRoad.set(e.roadId, []);
    byRoad.get(e.roadId).push(i);
  }
  const rng = new RNG(seed + ':names');
  const stems = typeof massing === 'string' && Object.prototype.hasOwnProperty.call(NAME_POOLS, massing) && Array.isArray(NAME_POOLS[massing])
    ? NAME_POOLS[massing]
    : NAME_POOLS.mixed;
  const used = new Set();
  const corridors = [];
  for (const [id, edgeIds] of [...byRoad.entries()].sort((a, b) => a[0] - b[0])) {
    // Order the edges into a chain: walk from a degree-1 end of the sub-graph.
    const deg = new Map();
    for (const ei of edgeIds) for (const n of [g.edges[ei].a, g.edges[ei].b]) deg.set(n, (deg.get(n) || 0) + 1);
    let start = [...deg.entries()].filter(([, d]) => d === 1).map(([n]) => n).sort((a, b) => a - b)[0];
    if (start === undefined) start = g.edges[edgeIds[0]].a; // a loop; pick a stable node
    const left = new Set(edgeIds), chain = [], nodes = [start];
    let cur = start;
    while (left.size) {
      const next = [...left].find(ei => g.edges[ei].a === cur || g.edges[ei].b === cur);
      if (next === undefined) break; // disconnected pieces (rare): stop at this chain
      left.delete(next); chain.push(next);
      cur = g.other(next, cur); nodes.push(cur);
    }
    const cls = g.edges[chain[0]].cls;
    const length = chain.reduce((s, ei) => s + g.edgeLength(ei), 0);
    const name = corridorName(rng, stems, cls, used);
    used.add(name);
    corridors.push({ id, cls, name, edgeIds: chain, nodeIds: nodes, length, polyline: nodes.map(n => [g.nodes[n].x, g.nodes[n].z]), orphan: left.size });
  }
  return corridors.sort((a, b) => b.length - a.length);
}
