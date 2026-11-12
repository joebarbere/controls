import {
  type AccessoryDefinition,
  awgInRange,
  drivesFit,
  type TerminalMethodSpec,
  terminationMethod,
  type ToolDefinition,
} from '@controls/catalog';
import type { TerminationArgs, TerminationConductor } from './resolve';

/*
 * Apprentice preselection (D9, ADR 0015, "Which command a surface logs"): the right hole, die and
 * torque for a conductor on a terminal, from the tools at hand, so no surface encodes which is right.
 * A suggestion is the ideal landing the command accepts (the spec checks it lands with no nicks, a
 * full crimp and the specified torque setting); `null` when the tools at hand can't make one.
 */

const capability = (tool: ToolDefinition, step: string, awg: number | null): boolean =>
  tool.capabilities.some((c) => c.step === step && (awg === null || c.maxAwg === null || awg >= c.maxAwg));

/** Whether `spec` takes `conductor` bare (`stranded`/`solid`) or only in a ferrule. */
function acceptance(spec: TerminalMethodSpec, conductor: TerminationConductor): 'bare' | 'ferrule' | null {
  if (!awgInRange(conductor.awg, spec.awgRange)) return null;
  if (spec.stranding.includes(conductor.stranding)) return 'bare';
  if (conductor.stranding === 'stranded' && spec.stranding.includes('strandedFerrule')) return 'ferrule';
  return null;
}

/**
 * The ideal termination of `conductor` on a terminal with `methods` (in their catalogue order), using
 * the first suitable of `tools` for each step (a driver whose drive types fit the screw's) and, where the method needs one, the first fitting
 * ferrule of `accessories`; or `null`. The first method that can be completed wins.
 */
export function suggestTermination(
  methods: readonly TerminalMethodSpec[],
  conductor: TerminationConductor,
  tools: readonly ToolDefinition[],
  accessories: readonly AccessoryDefinition[] = [],
): TerminationArgs | null {
  for (const spec of methods) {
    const method = terminationMethod(spec.method);
    const accepts = acceptance(spec, conductor);
    if (!method || accepts === null) continue;
    const stripper = tools.find(
      (t) =>
        capability(t, 'strip', conductor.awg) &&
        t.holes.some((h) => h.awg === conductor.awg && h.stranding === conductor.stranding),
    );
    if (!stripper) continue;
    const hole = stripper.holes.find((h) => h.awg === conductor.awg && h.stranding === conductor.stranding);
    let accessory: TerminationArgs['accessory'] = null;
    if (accepts === 'ferrule') {
      const ferrule = accessories.find(
        (a) =>
          a.kind === 'ferrule' &&
          method.accessories.includes('ferrule') &&
          awgInRange(conductor.awg, a.awgRange) &&
          a.stranding.includes(conductor.stranding),
      );
      const crimper =
        ferrule &&
        tools.find(
          (t) =>
            capability(t, 'crimp', conductor.awg) &&
            t.dies.some((d) => ferrule.dies.includes(d.id) && awgInRange(conductor.awg, d.awgRange)),
        );
      const die = crimper?.dies.find((d) => ferrule?.dies.includes(d.id) && awgInRange(conductor.awg, d.awgRange));
      if (!ferrule || !crimper || !die) continue;
      accessory = {
        ref: { id: ferrule.id, version: ferrule.version },
        tool: { id: crimper.id, version: crimper.version },
        die: die.id,
      };
    }
    let clamp: TerminationArgs['clamp'] = { tool: null, torqueNm: null };
    if (method.clampTorque && spec.torqueNm !== null) {
      const torque = spec.torqueNm;
      const fits = (t: ToolDefinition) => capability(t, 'drive', conductor.awg) && drivesFit(t.drives, spec.drives);
      const torqueDriver = tools.find(
        (t) => fits(t) && t.torque !== null && torque >= t.torque.minNm && torque <= t.torque.maxNm,
      );
      const driver = torqueDriver ?? tools.find((t) => fits(t) && t.torque === null);
      if (!driver) continue;
      clamp = { tool: { id: driver.id, version: driver.version }, torqueNm: torqueDriver ? torque : null };
    }
    return {
      method: spec.method,
      strip: {
        tool: { id: stripper.id, version: stripper.version },
        hole: (hole as NonNullable<typeof hole>).id,
        lengthMm: spec.stripLengthMm.nominal,
      },
      accessory,
      clamp,
    };
  }
  return null;
}
