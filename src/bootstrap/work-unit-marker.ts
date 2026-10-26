/**
 * #1240 — the work-unit marker, the one place it is written and read.
 *
 * A planned issue's body ends, after a blank line, with `Work unit <k> of <n>: <key>`: the link from
 * the issue to one approved work unit. It links; it proves nothing about the issue's content, which
 * blind review judges. Repo Factory's genesis issues and ACP's STANDARD_WORK issues carry the same
 * form. Repo Factory's unit rule may change, so nothing else parses or spells the line.
 */
export interface WorkUnitMarker {
  k: number;
  n: number;
  key: string;
}

const WORK_UNIT = /^Work unit ([1-9]\d*) of ([1-9]\d*): ([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** Every marker line of a body, in order, and whether the last line is one of them. */
export const workUnitMarkers = (body: string | null | undefined): { markers: WorkUnitMarker[]; last: WorkUnitMarker | null } => {
  const lines = (body ?? "").trimEnd().split(/\r?\n/);
  const markers: WorkUnitMarker[] = [];
  let last: WorkUnitMarker | null = null;
  for (const [index, line] of lines.entries()) {
    const match = WORK_UNIT.exec(line);
    if (match === null) continue;
    const marker = { k: Number(match[1]), n: Number(match[2]), key: match[3]! };
    markers.push(marker);
    if (index === lines.length - 1) last = marker;
  }
  return { markers, last };
};

/** The body a planned issue is written with: its text, a blank line, then its marker. */
export const withWorkUnitMarker = (body: string, marker: WorkUnitMarker): string =>
  `${body.trimEnd()}\n\nWork unit ${marker.k} of ${marker.n}: ${marker.key}`;
