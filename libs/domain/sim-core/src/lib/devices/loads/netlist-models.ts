import type { HeaterParams, ResistorParams } from '@controls/catalog';
import type { DeviceNetlistModel } from '../../netlist/models';

/*
 * The netlist models of F2.5's fixed resistive loads: one `resistor` element `element` from `a` to
 * `b`, valued from the catalogue entry (the resistance travels as a netlist value, so
 * `DC_DEFAULT_VALUES` and `AC_DEFAULT_VALUES` can stamp it). Kept apart from the engine models, as
 * the sources' are, so `netlist/models.ts` can register them without an import cycle.
 */

/** A resistor (`resistor`): its catalogue resistance between `a` and `b`. */
export const resistorNetlistModel: DeviceNetlistModel = {
  kind: 'resistor',
  simTopologyKeys: [],
  topology: ({ params }) => ({
    joins: [],
    elements: [
      {
        part: 'element',
        kind: 'resistor',
        source: null,
        a: 'a',
        b: 'b',
        values: { resistanceOhm: (params as ResistorParams).resistanceOhm },
      },
    ],
  }),
};

/** A heater (`heater`): its rated resistance V_r² / P_r between `a` and `b`. */
export const heaterNetlistModel: DeviceNetlistModel = {
  kind: 'heater',
  simTopologyKeys: [],
  topology: ({ params }) => {
    const p = params as HeaterParams;
    return {
      joins: [],
      elements: [
        {
          part: 'element',
          kind: 'resistor',
          source: null,
          a: 'a',
          b: 'b',
          values: { resistanceOhm: (p.ratedVoltageV * p.ratedVoltageV) / p.ratedPowerW },
        },
      ],
    };
  },
};
