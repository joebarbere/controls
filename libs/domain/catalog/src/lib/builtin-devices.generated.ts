/*
 * GENERATED from content/devices/*.json by builtin.spec.ts: do not edit. Edit the JSON files and
 * regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_DEVICE_DOCUMENTS: readonly unknown[] = [
{
  "id": "battery.ferrovane-12v-7ah",
  "version": 1,
  "title": "12 V 7 Ah sealed lead-acid battery",
  "brand": "Ferrovane",
  "modelName": "FV12-7",
  "category": "source",
  "sizeMm": {
    "widthMm": 151,
    "heightMm": 65,
    "depthMm": 98
  },
  "terminals": [
    {
      "id": "neg",
      "label": "−",
      "positionMm": {
        "x": 18,
        "y": 32,
        "z": 98
      }
    },
    {
      "id": "pos",
      "label": "+",
      "positionMm": {
        "x": 133,
        "y": 32,
        "z": 98
      }
    }
  ],
  "model": {
    "kind": "battery",
    "params": {
      "nominalVoltageV": 12,
      "openCircuitVoltageFullV": 12.9,
      "openCircuitVoltageEmptyV": 11.8,
      "internalResistanceOhm": 0.023,
      "capacityAh": 7
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "vrla-12v-7ah-class",
      "kind": "real-world",
      "citation": "The 12 V 7 Ah valve-regulated lead-acid (VRLA, AGM) monobloc, a common alarm and UPS battery class: six 2 V cells (12 V nominal), 7 Ah at the 20-hour rate, case about 151 × 65 × 94 mm and 98 mm to the terminal tops. Typical of published manufacturer datasheets for the class, paraphrased; not one vendor's values. The size is the footprint on the bench (151 × 65 mm) and the height above it (98 mm).",
      "covers": [
        "model.params.nominalVoltageV",
        "model.params.capacityAh",
        "sizeMm"
      ]
    },
    {
      "id": "lead-acid-open-circuit-voltage",
      "kind": "real-world",
      "citation": "A rested lead-acid cell's open-circuit voltage is roughly its electrolyte's specific gravity plus 0.84 V. For a VRLA monobloc at 25 °C, published state-of-charge charts give about 12.9 V (2.15 V per cell) at full charge and about 11.8 V (1.97 V per cell) fully discharged. Paraphrased from the lead-acid chapters of Linden's Handbook of Batteries (T. B. Reddy, ed., 4th ed., McGraw-Hill, 2011) and VRLA manufacturers' charts.",
      "covers": [
        "model.params.openCircuitVoltageFullV",
        "model.params.openCircuitVoltageEmptyV"
      ]
    },
    {
      "id": "vrla-internal-resistance",
      "kind": "real-world",
      "citation": "Internal resistance of a fully charged 12 V 7 Ah VRLA battery at 25 °C: about 23 mΩ, mid-range of the class's published datasheets (roughly 17 to 28 mΩ). Those figures are usually 1 kHz AC tester readings, which read lower than the DC resistance a step load sees; F2.4 records using the AC figure as a DC internal resistance as an abstraction.",
      "covers": [
        "model.params.internalResistanceOhm"
      ]
    },
    {
      "id": "terminal-layout",
      "kind": "game-design",
      "citation": "game-design: the two terminals sit on the top of the case, 115 mm apart, chosen for drawing leads; not modelled on a product.",
      "covers": [
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "lamp.lumivane-12v-5w",
  "version": 1,
  "title": "12 V 5 W incandescent lamp on a base",
  "brand": "Lumivane",
  "modelName": "LV-12-5",
  "category": "load",
  "sizeMm": {
    "widthMm": 50,
    "heightMm": 50,
    "depthMm": 60
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 25,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 40,
        "y": 25,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "lamp.incandescent",
    "params": {
      "ratedVoltageV": 12,
      "ratedPowerW": 5
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "unece-r37-w5w",
      "kind": "real-world",
      "citation": "UN ECE Regulation No. 37 (filament lamps for power-driven vehicles), category W5W: a 12 V wedge-base signal lamp whose 5 W is defined at R37's 13.5 V test voltage. Taking 5 W at 12 V (ratedPowerW at ratedVoltageV) is a game-design simplification. Only the rated values are used; the regulation's text and data sheets are not reproduced.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "holder-layout",
      "kind": "game-design",
      "citation": "game-design: the lamp stands in a holder on a 50 × 50 mm base, 60 mm tall, with a screw terminal on each side of the base; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "lead.quillfern-test-1m",
  "version": 1,
  "title": "1 m 18 AWG test lead with crocodile clips",
  "brand": "Quillfern",
  "modelName": "QF-TL1",
  "category": "lead",
  "sizeMm": null,
  "terminals": [],
  "model": {
    "kind": "lead",
    "params": {
      "lengthMm": 1000,
      "conductorAreaM2": 8.2305e-7,
      "resistivityOhmM": 1.724137931034483e-8,
      "temperatureCoefficientPerK": 0.00393,
      "referenceTemperatureK": 293.15,
      "contactResistanceOhm": 0.01
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "annealed-copper-standard",
      "kind": "real-world",
      "citation": "International Annealed Copper Standard (IEC 60028, 1925): annealed copper has a resistivity of 1/58 Ω·mm²/m (1.7241 × 10⁻⁸ Ω·m) at 20 °C (293.15 K), and a temperature coefficient of resistance of 0.00393 per kelvin at 20 °C. The lead's resistance is computed from these (resistivity × length ÷ area, with the temperature coefficient), never taken from a conductor table.",
      "covers": [
        "model.params.resistivityOhmM",
        "model.params.temperatureCoefficientPerK",
        "model.params.referenceTemperatureK"
      ]
    },
    {
      "id": "awg-18-cross-section",
      "kind": "real-world",
      "citation": "18 AWG, the usual gauge of US bench test leads (NEC/US-first). The area is derived from the public AWG definition (ASTM B258): d = 0.127 mm × 92^((36 − n)/39), so 18 AWG is d ≈ 1.0237 mm and A = π d²/4 ≈ 0.8231 mm² (8.2305e-7 m²); it is not taken from any NEC table. Stranding is ignored: real flexible leads measure about 10 % above this solid-wire figure.",
      "covers": [
        "model.params.conductorAreaM2"
      ]
    },
    {
      "id": "lead-length",
      "kind": "game-design",
      "citation": "game-design: a 1 m bench test lead, a common retail length.",
      "covers": [
        "model.params.lengthMm"
      ]
    },
    {
      "id": "clip-contact-resistance",
      "kind": "real-world",
      "citation": "10 mΩ at each end, where a sprung test clip grips a terminal: typical published test-clip contact ratings are roughly 6 to 15 mΩ (paraphrased from manufacturers' clip specifications; no single vendor).",
      "covers": [
        "model.params.contactResistanceOhm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "switch.tessaline-spst-toggle",
  "version": 1,
  "title": "SPST toggle switch on a base",
  "brand": "Tessaline",
  "modelName": "TS-101",
  "category": "switch",
  "sizeMm": {
    "widthMm": 60,
    "heightMm": 40,
    "depthMm": 45
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 20,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 50,
        "y": 20,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "switch.spst",
    "params": {}
  },
  "controls": [
    {
      "id": "closed",
      "label": "Closed",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: a single-pole, single-throw toggle switch on a 60 × 40 mm base, 45 mm tall, with a screw terminal at each end; not modelled on a product. The switch is ideal in P2 (closed joins its terminals), so it has no electrical parameters yet.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
}
];
