import {
  type AccessoryDefinition,
  awgName,
  type Catalog,
  type TerminalMethodSpec,
  terminationMethod,
  type ToolDefinition,
} from '@controls/catalog';
import type { Difficulty } from '@controls/save-format';
import {
  type CatalogRef,
  checkConductor,
  checkLanding,
  defaultTool,
  findEntity,
  suggestTermination,
  type TerminationArg,
  type TerminationArgs,
  TerminationArgsSchema,
  terminationConductor,
  toolCan,
  type World,
} from '@controls/world-model';
import type { GestureTerminal } from './routing-gesture';

/*
 * The termination prompts' model (F3.3 part 2, D9, ADR 0015 "Which command a surface logs"), pure so
 * every difficulty is unit-tested without Angular. A prompt collects one end's tool steps: one
 * strip-and-finish step (the method, the stripper and its hole, the strip length, an optional
 * crimped ferrule or lug with the crimper's die) and, for a method with a clamp torque, one torque
 * step (the driver and its setting). What it yields is a `TerminationArgs`, which goes into the one
 * `wire.add` the route logs: the prompts never log anything themselves.
 *
 * - **Automatic** (Trainee): no prompt; the end lands `'auto'`.
 * - **Preselected** (Apprentice): every field filled from `suggestTermination` (world-model), so no
 *   surface encodes which hole, die or torque is right; the player confirms or changes them.
 * - **Blank** (Journeyman, Realistic): only the tools in hand are filled (the default-tool rule,
 *   shown, never picked silently) and a method when the terminal has just one; the hole, strip length,
 *   accessory, die and torque setting are the player's.
 *
 * The outcome (nicks, crimp quality, achieved torque) is never shown here: the command resolves it.
 */

/** How a difficulty prompts for terminations (D9). */
export type PromptMode = 'automatic' | 'preselected' | 'blank';

export function promptMode(difficulty: Difficulty): PromptMode {
  switch (difficulty) {
    case 'trainee':
      return 'automatic';
    case 'apprentice':
      return 'preselected';
    case 'journeyman':
    case 'realistic':
      return 'blank';
  }
}

/** `id@version`: a catalogue ref as a form value. */
export const refKey = (ref: CatalogRef): string => `${ref.id}@${ref.version}`;

/** A tool the prompt offers, belt tools first. */
export interface ToolOption {
  readonly key: string;
  readonly ref: CatalogRef;
  readonly tool: ToolDefinition;
  /** `Wire strippers, … (belt slot 2)` or `… (not on the belt)`. */
  readonly label: string;
}

/** A method the terminal takes, with what the prompt needs to show about it. */
export interface MethodOption {
  readonly method: string;
  readonly spec: TerminalMethodSpec;
  /** Whether it is tightened to a torque (a torque step follows). */
  readonly clampTorque: boolean;
  /** The accessory kinds it takes (`ferrule`, `ringLug`, `forkLug`). */
  readonly accessoryKinds: readonly string[];
}

/** What the player fills in, as form values (`null` or `''` is blank). */
export interface TerminationDraft {
  readonly method: string | null;
  readonly stripTool: string | null;
  readonly hole: string | null;
  readonly stripLengthMm: string;
  /** An accessory key, or `'none'`. */
  readonly accessory: string;
  readonly crimpTool: string | null;
  readonly die: string | null;
  readonly driver: string | null;
  readonly torqueNm: string;
}

/** One end's prompt: the terminal, the conductor, the choices and the starting draft. */
export interface TerminationRequest {
  readonly end: 'a' | 'b';
  readonly terminal: GestureTerminal;
  /** `… #3, terminal 1`. */
  readonly terminalTitle: string;
  readonly conductorTitle: string;
  /** `14 AWG solid`. */
  readonly conductorSize: string;
  readonly mode: Exclude<PromptMode, 'automatic'>;
  readonly methods: readonly MethodOption[];
  readonly strippers: readonly ToolOption[];
  readonly crimpers: readonly ToolOption[];
  readonly drivers: readonly ToolOption[];
  readonly accessories: readonly AccessoryDefinition[];
  readonly draft: TerminationDraft;
  /** At Apprentice when the tools at hand can't make an ideal landing: why nothing is preselected. */
  readonly note: string | null;
}

const METHOD_NAMES: Readonly<Record<string, string>> = {
  screw: 'Screw clamp',
  springCage: 'Spring cage',
  backStab: 'Back-stab (push-in)',
  twistOn: 'Twist-on splice',
};
/** `Screw clamp`, `Spring cage`, …: a method as the player reads it. */
export const methodName = (method: string): string => METHOD_NAMES[method] ?? method;

const DRIVE_NAMES: Readonly<Record<string, string>> = { pozidriv: 'Pozidriv', phillips: 'Phillips' };
/** `slotted or Pozidriv`: a screw's drive types. */
export const drivesName = (drives: readonly string[]): string => drives.map((d) => DRIVE_NAMES[d] ?? d).join(' or ');

/** `14 AWG solid`. */
export const sizeName = (awg: number, stranding: string): string => `${awgName(awg)} AWG ${stranding}`;

/**
 * The tools at hand for a prompt: the belt's tools in slot order, then every other catalogue tool
 * (newest version per id), as the default-tool rule falls back to the catalogue (ADR 0015).
 */
export function toolsAtHand(catalog: Catalog, belt: readonly (CatalogRef | null)[]): ToolOption[] {
  const seen = new Set<string>();
  const options: ToolOption[] = [];
  belt.forEach((ref, i) => {
    const tool = ref && catalog.family(ref) === 'tool' ? catalog.tool(ref) : undefined;
    if (!tool || seen.has(tool.id)) return;
    seen.add(tool.id);
    const r = { id: tool.id, version: tool.version };
    options.push({ key: refKey(r), ref: r, tool, label: `${tool.title} (belt slot ${i + 1})` });
  });
  const newest = new Map<string, ToolDefinition>();
  for (const tool of catalog.tools) newest.set(tool.id, tool); // sorted by id, then version
  for (const tool of newest.values()) {
    if (seen.has(tool.id)) continue;
    const r = { id: tool.id, version: tool.version };
    options.push({ key: refKey(r), ref: r, tool, label: `${tool.title} (not on the belt)` });
  }
  return options;
}

const BLANK_DRAFT: TerminationDraft = {
  method: null,
  stripTool: null,
  hole: null,
  stripLengthMm: '',
  accessory: 'none',
  crimpTool: null,
  die: null,
  driver: null,
  torqueNm: '',
};

/** A number as a form shows it (`0.6`, not `0.6000000000000001`). */
const numberText = (n: number): string => String(Number(n.toPrecision(12)));

/**
 * The prompt for landing the spool's conductor on `terminal`, or a refusal when nothing could land
 * there (`wrong-method`: a clip-only terminal; or the spool isn't a conductor). `null` at Trainee.
 */
export function terminationRequest(
  world: World,
  catalog: Catalog,
  belt: readonly (CatalogRef | null)[],
  spool: CatalogRef,
  end: 'a' | 'b',
  terminal: GestureTerminal,
  terminalTitle: string,
):
  | { readonly ok: true; readonly request: TerminationRequest | null }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const mode = promptMode(world.difficulty);
  if (mode === 'automatic') return { ok: true, request: null };
  const entry = checkConductor(catalog, spool);
  if (!entry.ok) return { ok: false, code: entry.code, message: entry.message };
  const conductor = terminationConductor(entry.value.spec);
  const entity = findEntity(world, terminal.entity);
  const specs =
    (entity && catalog.device(entity.ref)?.terminals.find((t) => t.id === terminal.terminal)?.methods) ?? [];
  const methods: MethodOption[] = [];
  for (const spec of specs) {
    const def = terminationMethod(spec.method);
    if (def) methods.push({ method: spec.method, spec, clampTorque: def.clampTorque, accessoryKinds: def.accessories });
  }
  if (methods.length === 0) {
    return { ok: false, code: 'wrong-method', message: `${terminalTitle} takes no conductor (clips only)` };
  }
  const tools = toolsAtHand(catalog, belt);
  const awg = conductor.awg;
  const strippers = tools.filter((t) => toolCan(t.tool, 'strip', awg));
  const crimpers = tools.filter((t) => toolCan(t.tool, 'crimp', awg));
  const drivers = tools.filter((t) => toolCan(t.tool, 'drive', awg));
  const keyOf = (ref: CatalogRef | null | undefined) => (ref ? refKey(ref) : null);

  // The tools in hand: the default-tool rule (belt first, else the catalogue), for every mode.
  const only = methods.length === 1 ? methods[0] : null;
  const inHand: TerminationDraft = {
    ...BLANK_DRAFT,
    method: only?.method ?? null,
    stripTool: keyOf(defaultTool(catalog, belt, 'strip', awg)?.ref),
    crimpTool: keyOf(defaultTool(catalog, belt, 'crimp', awg)?.ref),
    driver: keyOf(defaultTool(catalog, belt, 'drive', awg, only?.spec.drives ?? null)?.ref),
  };
  let draft = inHand;
  let note: string | null = null;
  if (mode === 'preselected') {
    const suggestion = suggestTermination(
      specs,
      conductor,
      tools.map((t) => t.tool),
      catalog.accessories,
    );
    if (suggestion) draft = draftOf(suggestion, inHand);
    else note = 'The tools at hand can’t make an ideal landing here: nothing is preselected.';
  }
  return {
    ok: true,
    request: {
      end,
      terminal: { entity: terminal.entity, terminal: terminal.terminal },
      terminalTitle,
      conductorTitle: entry.value.device.title,
      conductorSize: sizeName(conductor.awg, conductor.stranding),
      mode,
      methods,
      strippers,
      crimpers,
      drivers,
      accessories: catalog.accessories,
      draft,
      note,
    },
  };
}

/** A suggestion (or any arguments) as a draft; the driver stays `fallback`'s when the method has none. */
export function draftOf(args: TerminationArgs, fallback: TerminationDraft = BLANK_DRAFT): TerminationDraft {
  return {
    method: args.method,
    stripTool: refKey(args.strip.tool),
    hole: args.strip.hole,
    stripLengthMm: String(args.strip.lengthMm),
    accessory: args.accessory ? refKey(args.accessory.ref) : 'none',
    crimpTool: args.accessory ? refKey(args.accessory.tool) : fallback.crimpTool,
    die: args.accessory?.die ?? null,
    driver: args.clamp.tool ? refKey(args.clamp.tool) : fallback.driver,
    torqueNm: args.clamp.torqueNm === null ? '' : numberText(args.clamp.torqueNm),
  };
}

/** The draft's method option, or `undefined`. */
export const methodOf = (request: TerminationRequest, draft: TerminationDraft): MethodOption | undefined =>
  request.methods.find((m) => m.method === draft.method);

/** The accessories the draft's method takes (every size: a wrong one is the command's refusal to give). */
export function accessoryChoices(request: TerminationRequest, draft: TerminationDraft): AccessoryDefinition[] {
  const kinds = methodOf(request, draft)?.accessoryKinds ?? [];
  return request.accessories.filter((a) => kinds.includes(a.kind));
}

const option = (options: readonly ToolOption[], key: string | null) => options.find((o) => o.key === key);

/** The chosen driver's torque range, or `null` for a driver without a setting (or none chosen). */
export function driverTorque(request: TerminationRequest, draft: TerminationDraft): ToolDefinition['torque'] {
  return option(request.drivers, draft.driver)?.tool.torque ?? null;
}

/** Whether the draft's method has a torque step. */
export const hasTorqueStep = (request: TerminationRequest, draft: TerminationDraft): boolean =>
  methodOf(request, draft)?.clampTorque ?? false;

/** A blank or malformed field: which one, and what to tell the player. */
export interface FieldProblem {
  readonly field: keyof TerminationDraft;
  readonly message: string;
}

/** The strip-and-finish step's blank or malformed fields, in form order. */
export function stripProblems(request: TerminationRequest, draft: TerminationDraft): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (!methodOf(request, draft)) problems.push({ field: 'method', message: 'Choose how the conductor lands.' });
  const stripper = option(request.strippers, draft.stripTool);
  if (!stripper) problems.push({ field: 'stripTool', message: 'Choose a stripper.' });
  else if (!stripper.tool.holes.some((h) => h.id === draft.hole)) {
    problems.push({ field: 'hole', message: 'Choose a strip hole.' });
  }
  const length = draft.stripLengthMm.trim();
  if (!/^\d{1,3}$/.test(length) || Number(length) < 1 || Number(length) > 100) {
    problems.push({ field: 'stripLengthMm', message: 'Enter the strip length in whole millimetres, 1 to 100.' });
  }
  if (draft.accessory !== 'none') {
    const crimper = option(request.crimpers, draft.crimpTool);
    if (!crimper) problems.push({ field: 'crimpTool', message: 'Choose a crimper.' });
    else if (!crimper.tool.dies.some((d) => d.id === draft.die)) {
      problems.push({ field: 'die', message: 'Choose a crimp die.' });
    }
  }
  return problems;
}

/** The torque step's blank or malformed fields (none without a torque step). */
export function torqueProblems(request: TerminationRequest, draft: TerminationDraft): FieldProblem[] {
  if (!hasTorqueStep(request, draft)) return [];
  const driver = option(request.drivers, draft.driver);
  if (!driver) return [{ field: 'driver', message: 'Choose a screwdriver.' }];
  if (driver.tool.torque === null) return [];
  const text = draft.torqueNm.trim();
  const value = Number(text);
  if (text === '' || !Number.isFinite(value) || value < 0) {
    return [{ field: 'torqueNm', message: 'Enter the torque setting in newton-metres.' }];
  }
  return [];
}

/**
 * The draft as logged arguments, or `null` while a field is blank or malformed. The command checks
 * the rest (a hole the wrong size nicks; a tool that can't do a step is `wrong-tool`; a setting outside
 * the driver's range is `beyond-tool-capacity`).
 */
export function argsOf(request: TerminationRequest, draft: TerminationDraft): TerminationArgs | null {
  if (stripProblems(request, draft).length > 0 || torqueProblems(request, draft).length > 0) return null;
  const method = methodOf(request, draft) as MethodOption;
  const stripper = option(request.strippers, draft.stripTool) as ToolOption;
  const accessory = draft.accessory === 'none' ? null : request.accessories.find((a) => refKey(a) === draft.accessory);
  const crimper = option(request.crimpers, draft.crimpTool);
  const driver = method.clampTorque ? option(request.drivers, draft.driver) : undefined;
  return {
    method: method.method,
    strip: { tool: { ...stripper.ref }, hole: draft.hole as string, lengthMm: Number(draft.stripLengthMm.trim()) },
    accessory:
      accessory && crimper
        ? {
            ref: { id: accessory.id, version: accessory.version },
            tool: { ...crimper.ref },
            die: draft.die as string,
          }
        : null,
    clamp: driver
      ? {
          tool: { ...driver.ref },
          torqueNm: driver.tool.torque === null ? null : Number(draft.torqueNm.trim()),
        }
      : { tool: null, torqueNm: null },
  };
}

/**
 * The command's own landing check for one end, before anything is logged (ADR 0015: surfaces pre-check
 * with the validation `run` uses): the argument schema (`bad-args`), then world-model's `checkLanding`;
 * `null` when `wire.add` would land it, else the refusal. `end` b
 * takes the termination id after a's. Never shows the outcome.
 */
export function landingRefusal(
  world: World,
  catalog: Catalog,
  spool: CatalogRef,
  end: 'a' | 'b',
  terminal: GestureTerminal,
  termination: TerminationArg,
): { readonly code: string; readonly message: string } | null {
  if (termination !== 'auto') {
    // The logged argument's own schema first, so the prompt never passes what `execFromInput` rejects.
    const parsed = TerminationArgsSchema.safeParse(termination);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { code: 'bad-args', message: `${issue?.path.join('.') || 'termination'}: ${issue?.message ?? 'invalid'}` };
    }
  }
  const entry = checkConductor(catalog, spool);
  if (!entry.ok) return { code: entry.code, message: entry.message };
  const checked = checkLanding(
    world,
    catalog,
    entry.value.spec,
    { entity: terminal.entity, terminal: terminal.terminal, termination },
    world.nextTerminationId + (end === 'b' ? 1 : 0),
    null,
  );
  return checked.ok ? null : { code: checked.code, message: checked.message };
}
