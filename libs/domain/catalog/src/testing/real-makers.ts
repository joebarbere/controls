/*
 * The realism charter's fictional-brands rule as a test guard (specs only; not exported from the
 * package). Real makers of electrical products, tools and wire whose names must never appear in a
 * catalogue entry's brand, model name, title or source citation: makers' names belong in ADR reference
 * notes. Not exhaustive; add a maker when a source is read from it. Words that are also ordinary English
 * ("ideal", "encore", "fluke") are left out to avoid false matches.
 */
export const REAL_MAKERS =
  /square ?d\b|schneider|eaton|cutler[- ]hammer|siemens|general electric|\bge\b|murray|milbank|southwire|hager|leviton|hubbell|pass ?& ?seymour|legrand|lutron|klein tools|wago|phoenix contact|greenlee|cerrowire|prysmian|\babb\b|thomas ?& ?betts|ilsco|burndy|panduit|mean ?well|weidm[uü]ller|allen[- ]bradley|rockwell|littelfuse|bussmann|mersen/i;

/**
 * Publications a source may cite by title though a maker's name is in it (a bibliographic reference, not
 * a brand): Jones and Langmuir's 1927 filament paper in the General Electric Review (the lamp entries).
 */
const PUBLICATIONS = /general electric review/gi;

/** The real maker named in `text` (outside a cited publication's title), or `null`. */
export function realMakerIn(text: string): string | null {
  return REAL_MAKERS.exec(text.replace(PUBLICATIONS, ''))?.[0] ?? null;
}
