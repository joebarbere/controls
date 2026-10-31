import type { DeviceOutputSchema } from '@controls/sim-protocol';
import type { SimDeviceModel } from '../engine/device-model';
import { BATTERY_MODEL, BENCH_SUPPLY_MODEL, DIN_PSU_MODEL } from './sources';

export * from './readings';
export * from './sources';

/*
 * The engine models of the built-in device kinds (plan F2.4, F2.5), by catalogue model kind. F2.4: the
 * battery (state of charge), the bench supply and the DIN PSU (CV/CC, hiccup). The lamp has no filament
 * model yet (F2.5), so an island holding one is unmodelled. A kind without an engine model keeps its
 * bag as loaded.
 */
export const BUILTIN_DEVICE_MODELS: Readonly<Record<string, SimDeviceModel>> = Object.freeze({
  battery: BATTERY_MODEL,
  'supply.bench': BENCH_SUPPLY_MODEL,
  'supply.dinPsu': DIN_PSU_MODEL,
});

/**
 * The output record schemas of the built-in models, by kind (ADR 0011 §5.4, as amended in F2.4).
 * `sim-protocol`'s `DEVICE_OUTPUT_SCHEMAS` is the protocol's registry of them; registering these there
 * (with a `SIM_PROTOCOL_VERSION` bump) lands with F2.3b's protocol work, which owns that table.
 */
export const BUILTIN_DEVICE_OUTPUTS: Readonly<Record<string, DeviceOutputSchema>> = Object.freeze(
  Object.fromEntries(
    Object.values(BUILTIN_DEVICE_MODELS)
      .filter((model) => model.output !== null)
      .map((model) => [model.kind, model.output as DeviceOutputSchema]),
  ),
);
