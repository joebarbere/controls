/*
 * GENERATED from content/devices/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
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
      },
      "methods": []
    },
    {
      "id": "pos",
      "label": "+",
      "positionMm": {
        "x": 133,
        "y": 32,
        "z": 98
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
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
  "id": "box.tinmoor-1g-steel",
  "version": 1,
  "title": "1-gang steel device box, 3 × 2 × 2-1/2 in, with cable clamps",
  "brand": "Tinmoor",
  "modelName": "TM-132C",
  "category": "enclosure",
  "sizeMm": {
    "widthMm": 51,
    "heightMm": 76,
    "depthMm": 64
  },
  "terminals": [],
  "mounts": [
    {
      "type": "studFlange",
      "widthMm": 51,
      "crossMm": 0
    }
  ],
  "enclosure": {
    "mounts": [
      {
        "id": "yoke",
        "type": "deviceYoke",
        "positionMm": {
          "x": 2,
          "y": 2,
          "z": 2
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 0
      }
    ],
    "entries": [
      {
        "id": "clamp-top",
        "type": "pryout",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 25,
          "y": 76,
          "z": 46
        },
        "axis": "-y"
      },
      {
        "id": "clamp-bottom",
        "type": "pryout",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 25,
          "y": 0,
          "z": 46
        },
        "axis": "+y"
      },
      {
        "id": "ko-top",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 25,
          "y": 76,
          "z": 18
        },
        "axis": "-y"
      },
      {
        "id": "ko-bottom",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 25,
          "y": 0,
          "z": 18
        },
        "axis": "+y"
      },
      {
        "id": "ko-back",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 25,
          "y": 38,
          "z": 0
        },
        "axis": "+z"
      }
    ],
    "interiorVolumeMm3": 209808
  },
  "conductor": null,
  "model": {
    "kind": "enclosure.box",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "box-class",
      "kind": "game-design",
      "citation": "game-design: the 3 × 2 × 2-1/2 in sheet-steel device (switch) box, a common trade designation for one-gang outlet boxes (sheet-steel outlet boxes are listed to UL 514A and described by NEMA OS 1, cited by number). The designation is the outside size: 3 in tall, 2 in wide and 2-1/2 in deep, rounded to whole millimetres (51 × 76 × 64 mm), with 2 mm drawn walls (sheet steel of about 1.6 mm, rounded up) on the sides and back, so the inside is 47 × 72 × 62 mm. Unverified against a specific manufacturer drawing; electrical-realism-reviewer checked the class dimensions (2026-11-12).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "interior-volume",
      "kind": "game-design",
      "citation": "game-design: computed from the inside dimensions above as a plain rectangular volume, 47 × 72 × 62 = 209808 mm³ (about 12.80 in³), about 2.4 % above the volume boxes of this class are marked with (rounded corners, clamps, ears). It is the drawn box's geometric volume, not a marked volume and not from any code table, and it must not be used unchanged as the box-fill allowance (P4 decides between a marked-volume field and a stated rule).",
      "covers": [
        "interiorVolumeMm3"
      ]
    },
    {
      "id": "yoke",
      "kind": "game-design",
      "citation": "game-design: one device yoke (one wiring device per gang, UL 514A by number). A mounted device's origin sits at the inside back-lower-left corner (2, 2, 2) facing out of the box (+z), so a device fills the gang from the back wall; P4's devices are sized to the gang.",
      "covers": [
        "mounts.yoke"
      ]
    },
    {
      "id": "entry-layout",
      "kind": "game-design",
      "citation": "game-design: a pryout behind each of the two internal cable clamps (top and bottom, toward the front, one cable each, the box clamps it) and three 1/2 in trade-size knockouts (top, bottom and back, one connector each), the usual openings of a steel device box with clamps; positions are on the outside wall faces and are not taken from a product drawing.",
      "covers": [
        "entries.clamp-top",
        "entries.clamp-bottom",
        "entries.ko-top",
        "entries.ko-bottom",
        "entries.ko-back"
      ]
    },
    {
      "id": "stud-flange",
      "kind": "game-design",
      "citation": "game-design: nailed or screwed to the side of a stud by a bracket (common practice for device boxes in wood framing); it takes its full width along the stud.",
      "covers": [
        "fits.studFlange"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "box.tinmoor-2g-nm",
  "version": 1,
  "title": "2-gang nonmetallic new-work device box",
  "brand": "Tinmoor",
  "modelName": "TM-2GN",
  "category": "enclosure",
  "sizeMm": {
    "widthMm": 102,
    "heightMm": 92,
    "depthMm": 76
  },
  "terminals": [],
  "mounts": [
    {
      "type": "studFlange",
      "widthMm": 102,
      "crossMm": 0
    }
  ],
  "enclosure": {
    "mounts": [
      {
        "id": "yoke-1",
        "type": "deviceYoke",
        "positionMm": {
          "x": 5,
          "y": 3,
          "z": 3
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 0
      },
      {
        "id": "yoke-2",
        "type": "deviceYoke",
        "positionMm": {
          "x": 51,
          "y": 3,
          "z": 3
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 0
      }
    ],
    "entries": [
      {
        "id": "clamp-top-1",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 28,
          "y": 92,
          "z": 40
        },
        "axis": "-y"
      },
      {
        "id": "clamp-top-2",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 74,
          "y": 92,
          "z": 40
        },
        "axis": "-y"
      },
      {
        "id": "clamp-bottom-1",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 28,
          "y": 0,
          "z": 40
        },
        "axis": "+y"
      },
      {
        "id": "clamp-bottom-2",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 74,
          "y": 0,
          "z": 40
        },
        "axis": "+y"
      }
    ],
    "interiorVolumeMm3": 602688
  },
  "conductor": null,
  "model": {
    "kind": "enclosure.box",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "box-class",
      "kind": "game-design",
      "citation": "game-design: a two-gang nonmetallic (PVC) new-work device box for wood framing, a common class listed to UL 514C and described by NEMA OS 2 (cited by number). Outside about 4 in wide, 3-5/8 in tall and 3 in deep, taken as 102 × 92 × 76 mm, with 3 mm drawn walls on the sides and back, so the inside is 96 × 86 × 73 mm: tall enough for the 3-9/32 in (83.3 mm) spacing of a wiring device's mounting screws. Unverified against a specific manufacturer drawing; electrical-realism-reviewer checked the class dimensions (2026-11-12).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "interior-volume",
      "kind": "game-design",
      "citation": "game-design: computed from the inside dimensions above as a plain rectangular volume, 96 × 86 × 73 = 602688 mm³ (about 36.8 in³), about 8 to 15 % above the 32 to 34 in³ two-gang nonmetallic boxes of this class are marked with (tapered walls, clamps). It is the drawn box's geometric volume, not a marked volume and not from any code table, and it must not be used unchanged as the box-fill allowance (P4 decides between a marked-volume field and a stated rule).",
      "covers": [
        "interiorVolumeMm3"
      ]
    },
    {
      "id": "yokes",
      "kind": "real-world",
      "citation": "real-world: two gangs on 1-13/16 in (1.812 in, 46 mm) centres, the gang spacing of multi-gang wall plates (dimension governed by NEMA WD 6, cited by number); wall-plate makers' published dimensions, read 2026-11-12. The two gangs are centred in the 96 mm inside width; a mounted device's origin sits at the inside back corner of its gang, facing out of the box (+z) (game-design).",
      "covers": [
        "mounts.yoke-1",
        "mounts.yoke-2"
      ]
    },
    {
      "id": "entry-layout",
      "kind": "game-design",
      "citation": "game-design: four built-in cable clamps (knock-in tabs), two in the top wall and two in the bottom, one cable each, the box clamps the cable itself; positions are on the outside wall faces, one per gang, and are not taken from a product drawing.",
      "covers": [
        "entries.clamp-top-1",
        "entries.clamp-top-2",
        "entries.clamp-bottom-1",
        "entries.clamp-bottom-2"
      ]
    },
    {
      "id": "stud-flange",
      "kind": "game-design",
      "citation": "game-design: a new-work box nailed to the side of a stud through its flange (common practice); it takes its full width along the stud.",
      "covers": [
        "fits.studFlange"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "box.tinmoor-4rd-nm-ceiling",
  "version": 1,
  "title": "4 in round nonmetallic ceiling box",
  "brand": "Tinmoor",
  "modelName": "TM-4RC",
  "category": "enclosure",
  "sizeMm": {
    "widthMm": 102,
    "heightMm": 102,
    "depthMm": 57
  },
  "terminals": [],
  "mounts": [
    {
      "type": "studFlange",
      "widthMm": 102,
      "crossMm": 0
    }
  ],
  "enclosure": {
    "mounts": [],
    "entries": [
      {
        "id": "clamp-top",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 51,
          "y": 102,
          "z": 30
        },
        "axis": "-y"
      },
      {
        "id": "clamp-bottom",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 51,
          "y": 0,
          "z": 30
        },
        "axis": "+y"
      },
      {
        "id": "clamp-left",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 0,
          "y": 51,
          "z": 30
        },
        "axis": "+x"
      },
      {
        "id": "clamp-right",
        "type": "clamp",
        "tradeSize": null,
        "maxCables": 1,
        "internalClamp": true,
        "positionMm": {
          "x": 102,
          "y": 51,
          "z": 30
        },
        "axis": "-x"
      }
    ],
    "interiorVolumeMm3": 390864
  },
  "conductor": null,
  "model": {
    "kind": "enclosure.box",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "box-class",
      "kind": "game-design",
      "citation": "game-design: a round nonmetallic (PVC) ceiling box of 4 in outside diameter for a luminaire, a common class listed to UL 514C and described by NEMA OS 2 (cited by number). Outside taken as a cylinder of 102 mm diameter and 57 mm deep (4 in and 2-1/4 in), with 3 mm drawn walls, so the inside is 96 mm across and 54 mm deep; its bounding box is 102 × 102 × 57 mm. Unverified against a specific manufacturer drawing; electrical-realism-reviewer checked the class dimensions (2026-11-12).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "interior-volume",
      "kind": "game-design",
      "citation": "game-design: computed from the inside dimensions above as a plain cylinder, π × (96 / 2)² × 54 = 390864 mm³ (about 23.85 in³), rounded to a whole mm³: about 17.5 % above the volume round nonmetallic boxes of this class are marked with, because their walls taper. It is the drawn box's geometric volume, not a marked volume and not from any code table, and it must not be used unchanged as the box-fill allowance (P4 decides between a marked-volume field and a stated rule).",
      "covers": [
        "interiorVolumeMm3"
      ]
    },
    {
      "id": "entry-layout",
      "kind": "game-design",
      "citation": "game-design: four built-in cable clamps (knock-in tabs) a quarter-turn apart around the wall, one cable each, the box clamps the cable itself. No mount for a luminaire in P3 (P4 brings luminaires). Positions are on the round wall at its quarter points and are not taken from a product drawing.",
      "covers": [
        "entries.clamp-top",
        "entries.clamp-bottom",
        "entries.clamp-left",
        "entries.clamp-right"
      ]
    },
    {
      "id": "joist-mount",
      "kind": "game-design",
      "citation": "game-design: nailed to the side of a joist or stud through its bracket (studFlange, common practice); it takes its full width along the framing member.",
      "covers": [
        "fits.studFlange"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "box.tinmoor-4sq-steel",
  "version": 1,
  "title": "4 in square steel junction box, 1-1/2 in deep",
  "brand": "Tinmoor",
  "modelName": "TM-4S15",
  "category": "enclosure",
  "sizeMm": {
    "widthMm": 102,
    "heightMm": 102,
    "depthMm": 40
  },
  "terminals": [],
  "mounts": [
    {
      "type": "studFlange",
      "widthMm": 102,
      "crossMm": 0
    }
  ],
  "enclosure": {
    "mounts": [],
    "entries": [
      {
        "id": "ko-top-1",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 34,
          "y": 102,
          "z": 20
        },
        "axis": "-y"
      },
      {
        "id": "ko-top-2",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 68,
          "y": 102,
          "z": 20
        },
        "axis": "-y"
      },
      {
        "id": "ko-bottom-1",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 34,
          "y": 0,
          "z": 20
        },
        "axis": "+y"
      },
      {
        "id": "ko-bottom-2",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 68,
          "y": 0,
          "z": 20
        },
        "axis": "+y"
      },
      {
        "id": "ko-left-1",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 0,
          "y": 34,
          "z": 20
        },
        "axis": "+x"
      },
      {
        "id": "ko-left-2",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 0,
          "y": 68,
          "z": 20
        },
        "axis": "+x"
      },
      {
        "id": "ko-right-1",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 102,
          "y": 34,
          "z": 20
        },
        "axis": "-x"
      },
      {
        "id": "ko-right-2",
        "type": "knockout",
        "tradeSize": "1/2",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 102,
          "y": 68,
          "z": 20
        },
        "axis": "-x"
      },
      {
        "id": "ko-back",
        "type": "knockout",
        "tradeSize": "3/4",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 51,
          "y": 51,
          "z": 0
        },
        "axis": "+z"
      }
    ],
    "interiorVolumeMm3": 364952
  },
  "conductor": null,
  "model": {
    "kind": "enclosure.box",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "box-class",
      "kind": "game-design",
      "citation": "game-design: the 4 in square, 1-1/2 in deep sheet-steel box, a common trade designation for junction and outlet boxes (UL 514A, NEMA OS 1, cited by number). The designation is the outside size, rounded to whole millimetres (102 × 102 × 40 mm), with 2 mm drawn walls on the sides and back, so the inside is 98 × 98 × 38 mm. Unverified against a specific manufacturer drawing; electrical-realism-reviewer checked the class dimensions (2026-11-12).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "interior-volume",
      "kind": "game-design",
      "citation": "game-design: computed from the inside dimensions above as a plain rectangular volume, 98 × 98 × 38 = 364952 mm³ (about 22.27 in³), about 6.1 % above the volume boxes of this class are marked with (rounded corners, ears). It is the drawn box's geometric volume, not a marked volume and not from any code table, and it must not be used unchanged as the box-fill allowance (P4 decides between a marked-volume field and a stated rule).",
      "covers": [
        "interiorVolumeMm3"
      ]
    },
    {
      "id": "entry-layout",
      "kind": "game-design",
      "citation": "game-design: two 1/2 in trade-size knockouts in each side wall and one 3/4 in knockout in the back, one connector each (real boxes often have concentric 1/2 and 3/4 in knockouts; each is one size here). No yoke: a device needs a raised cover or mud ring (P4). Positions are on the outside wall faces and are not taken from a product drawing.",
      "covers": [
        "entries.ko-top-1",
        "entries.ko-top-2",
        "entries.ko-bottom-1",
        "entries.ko-bottom-2",
        "entries.ko-left-1",
        "entries.ko-left-2",
        "entries.ko-right-1",
        "entries.ko-right-2",
        "entries.ko-back"
      ]
    },
    {
      "id": "stud-flange",
      "kind": "game-design",
      "citation": "game-design: fixed to the side of a stud by a bracket (common practice); it takes its full width along the stud.",
      "covers": [
        "fits.studFlange"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "breaker.saltmere-1p-15a",
  "version": 1,
  "title": "15 A single-pole thermal-magnetic circuit breaker on a base",
  "brand": "Saltmere",
  "modelName": "SB-115",
  "category": "protection",
  "sizeMm": {
    "widthMm": 40,
    "heightMm": 90,
    "depthMm": 70
  },
  "terminals": [
    {
      "id": "line",
      "label": "LINE",
      "positionMm": {
        "x": 20,
        "y": 80,
        "z": 20
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": 4,
          "drives": [
            "slotted",
            "square"
          ],
          "alRated": true,
          "entryMm": {
            "x": 20,
            "y": 90,
            "z": 20
          },
          "exitAxis": "+y",
          "clampType": "pressurePlate",
          "clampDepthMm": 10,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    },
    {
      "id": "load",
      "label": "LOAD",
      "positionMm": {
        "x": 20,
        "y": 10,
        "z": 20
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": 4,
          "drives": [
            "slotted",
            "square"
          ],
          "alRated": true,
          "entryMm": {
            "x": 20,
            "y": 0,
            "z": 20
          },
          "exitAxis": "-y",
          "clampType": "pressurePlate",
          "clampDepthMm": 10,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [
    {
      "type": "din35",
      "widthMm": 40,
      "crossMm": 0
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "breaker.thermalMagnetic",
    "params": {
      "ratedCurrentA": 15,
      "thermalTimeConstantS": 60,
      "ultimateTripRatio": 1.25,
      "magneticTripMinRatio": 8,
      "magneticTripMaxRatio": 12,
      "contactResistanceOhm": 0.01
    }
  },
  "controls": [
    {
      "id": "on",
      "label": "Handle on",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "molded-case-15a-class",
      "kind": "real-world",
      "citation": "The 15 A single-pole thermal-magnetic molded-case breaker of NEC-region branch circuits, listed to UL 489. Paraphrased, not reproduced: it carries its rating continuously, and must trip within an hour at 135 % (for ratings up to 50 A) and within two minutes at 200 % (up to 30 A). Manufacturers' watts-loss figures put a pole at about 2 W at its rating, about 150 mV, so a contact resistance of 10 mΩ is taken (2.25 W at 15 A).",
      "covers": [
        "model.params.ratedCurrentA",
        "model.params.contactResistanceOhm"
      ]
    },
    {
      "id": "trip-curve-band",
      "kind": "game-design",
      "citation": "game-design inside manufacturer-style curves for NEC-region residential thermal-magnetic breakers (not IEC 60898): inverse-time thermal trips from a little above the rating (ultimate trip 1.25 ×; a 60 s time constant gives about 30 s at 200 %), and an instantaneous magnetic pickup published as a band near ten times the rating (8 to 12 ×, drawn per breaker). The fictional datasheet's band, tested: 135 %: 30 s to 1 h; 200 %: 10 s to 2 min; 500 %: 1 to 15 s; 13 × and above: within 1 ms.",
      "covers": [
        "model.params.thermalTimeConstantS",
        "model.params.ultimateTripRatio",
        "model.params.magneticTripMinRatio",
        "model.params.magneticTripMaxRatio"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: a single-pole breaker on a 40 × 90 mm base, 70 mm tall, with the line terminal at the top and the load terminal at the bottom; standalone (no panel until P4); not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    },
    {
      "id": "breaker-terminal-class",
      "kind": "real-world",
      "citation": "The load (wire) screw terminal of 15 A single-pole plug-on and bolt-on branch breakers, from several makers' public specification sheets and installation instructions, paraphrased (not one vendor's): marked for copper or aluminium (CU/AL), 14 to 10 AWG (some to 8), solid or stranded, with a marked tightening torque of about 4.0 N·m (35 lb·in) for 14 to 10 AWG. The torque is the fictional breaker's marking; NFPA 70-2023 Art. 110.14(D) requires the marked value (cited by number). No UL 486A-B torque table is used.",
      "covers": [
        "terminals.load.methods.screw.awgRange",
        "terminals.load.methods.screw.stranding",
        "terminals.load.methods.screw.torqueNm",
        "terminals.load.methods.screw.alRated"
      ]
    },
    {
      "id": "breaker-line-stand-in",
      "kind": "game-design",
      "citation": "game-design: a panelboard branch breaker's line side is a stab or bolt onto the panel's bus, not a wire screw. Standing alone on its base (and on a DIN rail, D12), this breaker's line side takes a wire, so its line screw stands in for the bus connection, as the utility service stands in for the load centre; it copies the load terminal's values (14 to 10 AWG CU/AL, solid or stranded, 4.0 N·m). P4's panel replaces it with the bus.",
      "covers": [
        "terminals.line.methods.screw.awgRange",
        "terminals.line.methods.screw.stranding",
        "terminals.line.methods.screw.torqueNm",
        "terminals.line.methods.screw.alRated"
      ]
    },
    {
      "id": "breaker-terminal-counts",
      "kind": "game-design",
      "citation": "game-design: the fictional breaker is marked for one conductor per terminal (some makers list two of 14 to 10 AWG); two physically fit under the clamp, and a second makes a worse termination (D8). The 13 ± 2 mm strip length is chosen to fill the clamp without exposed copper; it is not a published figure.",
      "covers": [
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors",
        "terminals.*.methods.screw.stripLengthMm"
      ]
    },
    {
      "id": "breaker-terminal-geometry",
      "kind": "game-design",
      "citation": "game-design: conductors enter the line terminal from the top face and the load terminal from the bottom face of the 90 mm tall base, leaving along ±y; not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "breaker-din-mount",
      "kind": "game-design",
      "citation": "game-design: the breaker's base clips onto a 35 mm DIN rail (IEC 60715) and takes its full 40 mm base width along the rail (D12's demo puts it on a DIN mount). A real one-pole DIN-rail breaker is one module, about 17.5 to 18 mm wide; the base's width is kept so the entry's size is unchanged. Its terminals follow the panelboard branch-breaker class (a CU/AL load screw at 4.0 N·m), not the DIN-rail (UL 489 box-terminal) class. A real DIN-rail breaker is one module of about 18 mm per pole; a future entry version may take that.",
      "covers": [
        "fits.din35"
      ]
    },
    {
      "id": "breaker-screw-drives",
      "kind": "game-design",
      "citation": "game-design: a slotted and square (Robertson) combination head, as on many North American branch-breaker and panel screws (common practice, not one product); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "screw-terminal-contact",
      "kind": "real-world",
      "citation": "NBS Building Science Series 103 (W. J. Meese and R. W. Beausoliel, 1977; read in the P3 source pre-audit, ADR 0018 §4.1): good branch-circuit screw-terminal connections dropped 3 to 8 mV at 15 A, 0.2 to 0.5 mΩ. The class value 0.3 mΩ is taken as R₀, the contact resistance at the marked torque with a copper conductor at 20 °C; the engine scales it for torque, strip length, conductor count, strand spread, nicks, crimps and aluminium (ADR 0018 §4).",
      "covers": [
        "terminals.*.methods.screw.contactOhm"
      ]
    },
    {
      "id": "screw-terminal-thermal",
      "kind": "game-design",
      "citation": "game-design calibration (ADR 0018 §3.3, §11), for F3.6's hot-spot node: the heat path into the device, 0.026 W/K, is calibrated, not measured: with 14 AWG copper at 15 A it puts BSS 103's 18 to 36 W glowing connections between the threshold of visible glow (the Draper point, about 525 °C) and about 1000 °C. The clamp's heat capacity, 1.1 J/K, is a physics estimate: about 3 g of brass clamp parts × about 380 J/(kg·K).",
      "covers": [
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
      ]
    },
    {
      "id": "breaker-terminal-clamp",
      "kind": "game-design",
      "citation": "game-design: the fictional breaker's wire screws clamp the conductor under a pressure plate (a saddle) rather than wrapping it under a binding head, so bare strands are held (ADR 0018 §4.3); the plate grips 10 mm of conductor, inside the 13 ± 2 mm strip. Not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.quorvale-xhhw2-al-4-0-compact",
  "version": 1,
  "title": "4/0 AWG compact-stranded aluminium XHHW-2 building wire",
  "brand": "Quorvale",
  "modelName": "QV-XA-4-0",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": -3,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "aluminiumAa8000"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "xhhw2"
    },
    "insulationThicknessMm": 1.4,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "xhhw2-al-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 4/0 AWG aluminium XHHW-2 (a cable maker's public AA-8000 XHHW-2 datasheet, read; no ampacity column; listed to UL 44, cited by number): compact-stranded Class B AA-8000-series aluminium alloy, 19 strands, under a single cross-linked polyethylene (XLPE) wall of 1.4 mm, made in black. Rated 90 °C wet or dry: the pinned insulation row xhhw2. Aluminium building wire starts at 12 AWG (NFPA 70-2023 Art. 310.3(A), by number). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "aluminium-conductor",
      "kind": "real-world",
      "citation": "AA-8000-series aluminium alloy (ASTM B800, cited by number, paywalled, not read) at an assumed minimum 61.0 % IACS: the pinned materials row aluminiumAa8000 (NBS Handbook 109). Not 'EC-grade'. The area comes from the AWG definition (AWG_GAUGES) for compact strands too.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.quorvale-xhhw2-al-4-compact",
  "version": 1,
  "title": "4 AWG compact-stranded aluminium XHHW-2 building wire",
  "brand": "Quorvale",
  "modelName": "QV-XA-4",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 4,
    "stranding": "stranded",
    "strandCount": 7,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "aluminiumAa8000"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "xhhw2"
    },
    "insulationThicknessMm": 1.14,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "xhhw2-al-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 4 AWG aluminium XHHW-2 (a cable maker's public AA-8000 XHHW-2 datasheet, read; no ampacity column; listed to UL 44, cited by number): compact-stranded Class B AA-8000-series aluminium alloy, 7 strands, under a single cross-linked polyethylene (XLPE) wall of 1.14 mm, made in black. Rated 90 °C wet or dry: the pinned insulation row xhhw2. Aluminium building wire starts at 12 AWG (NFPA 70-2023 Art. 310.3(A), by number). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "aluminium-conductor",
      "kind": "real-world",
      "citation": "AA-8000-series aluminium alloy (ASTM B800, cited by number, paywalled, not read) at an assumed minimum 61.0 % IACS: the pinned materials row aluminiumAa8000 (NBS Handbook 109). Not 'EC-grade'. The area comes from the AWG definition (AWG_GAUGES) for compact strands too.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-bare-10-solid",
  "version": 1,
  "title": "10 AWG bare solid copper grounding conductor of NM-B cable",
  "brand": "Sorrelby",
  "modelName": "SB-NM-10B",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 10,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": null,
    "insulationThicknessMm": null,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "bare",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-egc-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B carries an uninsulated copper equipment grounding conductor, wrapped in fire-retardant paper and laid between or beside the insulated conductors; it is the circuit conductors' size at 14 to 10 AWG and 10 AWG in 8/3 and 6/3. A bare EGC is permitted by NFPA 70-2023 Art. 250.119 (by number). The paper wrap is not modelled (no insulation row, colour bare).",
      "covers": [
        "conductor.awg",
        "conductor.insulation",
        "conductor.colours"
      ]
    },
    {
      "id": "nm-egc-solid",
      "kind": "game-design",
      "citation": "game-design: solid, one strand. The sheet read makes 10 AWG circuit conductors solid and gives the 10 AWG grounding conductor of 8/3 and 6/3 without its stranding; solid is taken for every 10 AWG ground.",
      "covers": [
        "conductor.stranding",
        "conductor.strandCount"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-bare-12-solid",
  "version": 1,
  "title": "12 AWG bare solid copper grounding conductor of NM-B cable",
  "brand": "Sorrelby",
  "modelName": "SB-NM-12B",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 12,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": null,
    "insulationThicknessMm": null,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "bare",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-egc-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B carries an uninsulated copper equipment grounding conductor, wrapped in fire-retardant paper and laid between or beside the insulated conductors; it is the circuit conductors' size at 14 to 10 AWG and 10 AWG in 8/3 and 6/3. A bare EGC is permitted by NFPA 70-2023 Art. 250.119 (by number). The paper wrap is not modelled (no insulation row, colour bare).",
      "covers": [
        "conductor.awg",
        "conductor.insulation",
        "conductor.colours"
      ]
    },
    {
      "id": "nm-egc-solid",
      "kind": "real-world",
      "citation": "The sheet read makes every conductor of 12 AWG NM-B solid (soft copper per ASTM B3, by number), the grounding conductor included: one strand.",
      "covers": [
        "conductor.stranding",
        "conductor.strandCount"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-bare-14-solid",
  "version": 1,
  "title": "14 AWG bare solid copper grounding conductor of NM-B cable",
  "brand": "Sorrelby",
  "modelName": "SB-NM-14B",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 14,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": null,
    "insulationThicknessMm": null,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "bare",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-egc-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B carries an uninsulated copper equipment grounding conductor, wrapped in fire-retardant paper and laid between or beside the insulated conductors; it is the circuit conductors' size at 14 to 10 AWG and 10 AWG in 8/3 and 6/3. A bare EGC is permitted by NFPA 70-2023 Art. 250.119 (by number). The paper wrap is not modelled (no insulation row, colour bare).",
      "covers": [
        "conductor.awg",
        "conductor.insulation",
        "conductor.colours"
      ]
    },
    {
      "id": "nm-egc-solid",
      "kind": "real-world",
      "citation": "The sheet read makes every conductor of 14 AWG NM-B solid (soft copper per ASTM B3, by number), the grounding conductor included: one strand.",
      "covers": [
        "conductor.stranding",
        "conductor.strandCount"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-nm-10-solid",
  "version": 1,
  "title": "10 AWG solid copper conductor of NM-B cable (THHN-type)",
  "brand": "Sorrelby",
  "modelName": "SB-NM-10S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 10,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.508,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-conductor-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: the cable is listed to UL 719 and its insulated conductors to UL 83 (both by number); they are colour-coded PVC rated 90 °C dry under a nylon covering, solid copper at 14 to 10 AWG, with a total wall of about 24 mil at 10 AWG. That is the THHN construction, so this entry pins the thhnThwn2 insulation row and splits the wall as the THHN maker's sheet the Tallowmere entries cite does at this size (20 mil PVC under 4 mil nylon, 0.508 mm and 0.102 mm, rounded from mils). The row's wet rating never applies: NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number). Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm"
      ]
    },
    {
      "id": "nm-conductor-colours",
      "kind": "game-design",
      "citation": "game-design, following the common convention for NM-B: black and white in two-conductor cable, black, red and white in three-conductor cable (white identifies the grounded conductor, NFPA 70-2023 Art. 200.6, by number; black and red for ungrounded conductors are convention, not code). The sheet read does not list the conductor colours, so the entry is made in those three only.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-nm-12-solid",
  "version": 1,
  "title": "12 AWG solid copper conductor of NM-B cable (THHN-type)",
  "brand": "Sorrelby",
  "modelName": "SB-NM-12S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 12,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-conductor-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: the cable is listed to UL 719 and its insulated conductors to UL 83 (both by number); they are colour-coded PVC rated 90 °C dry under a nylon covering, solid copper at 14 to 10 AWG, with a total wall of about 19 mil at 12 AWG. That is the THHN construction, so this entry pins the thhnThwn2 insulation row and splits the wall as the THHN maker's sheet the Tallowmere entries cite does at this size (15 mil PVC under 4 mil nylon, 0.381 mm and 0.102 mm, rounded from mils). The row's wet rating never applies: NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number). Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm"
      ]
    },
    {
      "id": "nm-conductor-colours",
      "kind": "game-design",
      "citation": "game-design, following the common convention for NM-B: black and white in two-conductor cable, black, red and white in three-conductor cable (white identifies the grounded conductor, NFPA 70-2023 Art. 200.6, by number; black and red for ungrounded conductors are convention, not code). The sheet read does not list the conductor colours, so the entry is made in those three only.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-nm-14-solid",
  "version": 1,
  "title": "14 AWG solid copper conductor of NM-B cable (THHN-type)",
  "brand": "Sorrelby",
  "modelName": "SB-NM-14S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 14,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-conductor-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: the cable is listed to UL 719 and its insulated conductors to UL 83 (both by number); they are colour-coded PVC rated 90 °C dry under a nylon covering, solid copper at 14 to 10 AWG, with a total wall of about 19 mil at 14 AWG. That is the THHN construction, so this entry pins the thhnThwn2 insulation row and splits the wall as the THHN maker's sheet the Tallowmere entries cite does at this size (15 mil PVC under 4 mil nylon, 0.381 mm and 0.102 mm, rounded from mils). The row's wet rating never applies: NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number). Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm"
      ]
    },
    {
      "id": "nm-conductor-colours",
      "kind": "game-design",
      "citation": "game-design, following the common convention for NM-B: black and white in two-conductor cable, black, red and white in three-conductor cable (white identifies the grounded conductor, NFPA 70-2023 Art. 200.6, by number; black and red for ungrounded conductors are convention, not code). The sheet read does not list the conductor colours, so the entry is made in those three only.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-nm-6-stranded",
  "version": 1,
  "title": "6 AWG stranded copper conductor of NM-B cable (THHN-type)",
  "brand": "Sorrelby",
  "modelName": "SB-NM-6X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 6,
    "stranding": "stranded",
    "strandCount": 7,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": 0.127,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-conductor-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: the cable is listed to UL 719 and its insulated conductors to UL 83 (both by number); they are colour-coded PVC rated 90 °C dry under a nylon covering, 7-strand concentric copper at 8 and 6 AWG, with a total wall of about 35 mil at 6 AWG. That is the THHN construction, so this entry pins the thhnThwn2 insulation row and splits the wall as the THHN maker's sheet the Tallowmere entries cite does at this size (30 mil PVC under 5 mil nylon, 0.762 mm and 0.127 mm, rounded from mils). The row's wet rating never applies: NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number). Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm"
      ]
    },
    {
      "id": "nm-conductor-colours",
      "kind": "game-design",
      "citation": "game-design, following the common convention for NM-B: black and white in two-conductor cable, black, red and white in three-conductor cable (white identifies the grounded conductor, NFPA 70-2023 Art. 200.6, by number; black and red for ungrounded conductors are convention, not code). The sheet read does not list the conductor colours, so the entry is made in those three only.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.sorrelby-nm-8-stranded",
  "version": 1,
  "title": "8 AWG stranded copper conductor of NM-B cable (THHN-type)",
  "brand": "Sorrelby",
  "modelName": "SB-NM-8X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 8,
    "stranding": "stranded",
    "strandCount": 7,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": 0.127,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "nm-conductor-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: the cable is listed to UL 719 and its insulated conductors to UL 83 (both by number); they are colour-coded PVC rated 90 °C dry under a nylon covering, 7-strand concentric copper at 8 and 6 AWG, with a total wall of about 35 mil at 8 AWG. That is the THHN construction, so this entry pins the thhnThwn2 insulation row and splits the wall as the THHN maker's sheet the Tallowmere entries cite does at this size (30 mil PVC under 5 mil nylon, 0.762 mm and 0.127 mm, rounded from mils). The row's wet rating never applies: NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number). Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm"
      ]
    },
    {
      "id": "nm-conductor-colours",
      "kind": "game-design",
      "citation": "game-design, following the common convention for NM-B: black and white in two-conductor cable, black, red and white in three-conductor cable (white identifies the grounded conductor, NFPA 70-2023 Art. 200.6, by number; black and red for ungrounded conductors are convention, not code). The sheet read does not list the conductor colours, so the entry is made in those three only.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as the NM-B sheet states for the conductors (stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-mtw-10",
  "version": 1,
  "title": "10 AWG stranded copper MTW machine tool wire",
  "brand": "Tallowmere",
  "modelName": "TM-MTW-10",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 10,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "mtw"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": "yellow"
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "mtw-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 10 AWG Type MTW machine tool wire (a US maker's public MTW/TEW specification sheet, read; no ampacity column; listed to UL 1063, cited by number): flexible stranded bare copper, 19 strands, under a single 30 mil (0.762 mm) PVC wall. The single-layer construction is the pinned insulation row mtw (90 °C dry, 60 °C wet). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.insulation",
        "conductor.strandCount",
        "conductor.insulationThicknessMm"
      ]
    },
    {
      "id": "mtw-colours",
      "kind": "game-design",
      "citation": "game-design: a control-panel palette (black, red, blue, white, orange, yellow, green, and green with a yellow tracer). Makers offer about a dozen MTW colours without the sheets read naming them.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-mtw-12",
  "version": 1,
  "title": "12 AWG stranded copper MTW machine tool wire",
  "brand": "Tallowmere",
  "modelName": "TM-MTW-12",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 12,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "mtw"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": "yellow"
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "mtw-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 12 AWG Type MTW machine tool wire (a US maker's public MTW/TEW specification sheet, read; no ampacity column; listed to UL 1063, cited by number): flexible stranded bare copper, 19 strands, under a single 30 mil (0.762 mm) PVC wall. The single-layer construction is the pinned insulation row mtw (90 °C dry, 60 °C wet). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.insulation",
        "conductor.strandCount",
        "conductor.insulationThicknessMm"
      ]
    },
    {
      "id": "mtw-colours",
      "kind": "game-design",
      "citation": "game-design: a control-panel palette (black, red, blue, white, orange, yellow, green, and green with a yellow tracer). Makers offer about a dozen MTW colours without the sheets read naming them.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-mtw-14",
  "version": 1,
  "title": "14 AWG stranded copper MTW machine tool wire",
  "brand": "Tallowmere",
  "modelName": "TM-MTW-14",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 14,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "mtw"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": "yellow"
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "mtw-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 14 AWG Type MTW machine tool wire (a US maker's public MTW/TEW specification sheet, read; no ampacity column; listed to UL 1063, cited by number): flexible stranded bare copper, 19 strands, under a single 30 mil (0.762 mm) PVC wall. The single-layer construction is the pinned insulation row mtw (90 °C dry, 60 °C wet). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.insulation",
        "conductor.strandCount",
        "conductor.insulationThicknessMm"
      ]
    },
    {
      "id": "mtw-colours",
      "kind": "game-design",
      "citation": "game-design: a control-panel palette (black, red, blue, white, orange, yellow, green, and green with a yellow tracer). Makers offer about a dozen MTW colours without the sheets read naming them.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-mtw-16",
  "version": 1,
  "title": "16 AWG stranded copper MTW machine tool wire",
  "brand": "Tallowmere",
  "modelName": "TM-MTW-16",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 16,
    "stranding": "stranded",
    "strandCount": 26,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "mtw"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": "yellow"
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "mtw-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 16 AWG Type MTW machine tool wire (a US maker's public MTW/TEW specification sheet, read; no ampacity column; listed to UL 1063, cited by number): flexible stranded bare copper, 26 strands, under a single 30 mil (0.762 mm) PVC wall. The single-layer construction is the pinned insulation row mtw (90 °C dry, 60 °C wet). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.insulation",
        "conductor.strandCount",
        "conductor.insulationThicknessMm"
      ]
    },
    {
      "id": "mtw-colours",
      "kind": "game-design",
      "citation": "game-design: a control-panel palette (black, red, blue, white, orange, yellow, green, and green with a yellow tracer). Makers offer about a dozen MTW colours without the sheets read naming them.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (bunched (flexible) stranding per ASTM B174; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "game-design",
      "citation": "game-design: A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced. A 16 AWG MTW conductor is bunched (flexible) stranding, not concentric, so this concentric figure is applied to it as an approximation (bunched stranding is about 1.02 to 1.03, unverified); it moves the resistance by 1 % at most.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-mtw-18",
  "version": 1,
  "title": "18 AWG stranded copper MTW machine tool wire",
  "brand": "Tallowmere",
  "modelName": "TM-MTW-18",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 18,
    "stranding": "stranded",
    "strandCount": 16,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "mtw"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": null,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": "yellow"
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "mtw-construction",
      "kind": "real-world",
      "citation": "Typical published construction of Type MTW machine tool wire (a US maker's public MTW/TEW specification sheet, read; no ampacity column; listed to UL 1063, cited by number): flexible stranded bare copper under a single PVC wall (the sheet lists 16 to 10 AWG; the 18 AWG strand count and wall thickness are the game-design source mtw-18-assumed). The single-layer construction is the pinned insulation row mtw (90 °C dry, 60 °C wet). Paraphrased; no table copied.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.insulation"
      ]
    },
    {
      "id": "mtw-18-assumed",
      "kind": "game-design",
      "citation": "game-design: the sheet read lists 16 to 10 AWG only, so 18 AWG is taken with the same 30 mil (0.762 mm) PVC wall and 16 strands (a secondary listing seen in a search summary, not read). Unverified.",
      "covers": [
        "conductor.strandCount",
        "conductor.insulationThicknessMm"
      ]
    },
    {
      "id": "mtw-colours",
      "kind": "game-design",
      "citation": "game-design: a control-panel palette (black, red, blue, white, orange, yellow, green, and green with a yellow tracer). Makers offer about a dozen MTW colours without the sheets read naming them.",
      "covers": [
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (bunched (flexible) stranding per ASTM B174; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "game-design",
      "citation": "game-design: A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced. A 18 AWG MTW conductor is bunched (flexible) stranding, not concentric, so this concentric figure is applied to it as an approximation (bunched stranding is about 1.02 to 1.03, unverified); it moves the resistance by 1 % at most.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-1-0-stranded",
  "version": 1,
  "title": "1/0 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-1-0X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 0,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.27,
    "jacketThicknessMm": 0.178,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 1/0 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 50 mil PVC wall (1.27 mm) under a 7 mil nylon covering (0.178 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-10-solid",
  "version": 1,
  "title": "10 AWG solid copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-10S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 10,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.508,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 10 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 20 mil PVC wall (0.508 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-10-stranded",
  "version": 1,
  "title": "10 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-10X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 10,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.508,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 10 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 20 mil PVC wall (0.508 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-12-solid",
  "version": 1,
  "title": "12 AWG solid copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-12S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 12,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 12 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 15 mil PVC wall (0.381 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-12-stranded",
  "version": 1,
  "title": "12 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-12X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 12,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 12 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 15 mil PVC wall (0.381 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-14-solid",
  "version": 1,
  "title": "14 AWG solid copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-14S",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 14,
    "stranding": "solid",
    "strandCount": 1,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 14 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 15 mil PVC wall (0.381 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (solid per ASTM B3; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "solid-lay-factor",
      "kind": "real-world",
      "citation": "Physics definition: a solid conductor has no strand lay, so its lay factor is 1 and its resistance is that of its nominal area (ADR 0018 §2).",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-14-stranded",
  "version": 1,
  "title": "14 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-14X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 14,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.381,
    "jacketThicknessMm": 0.102,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 14 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made solid and 19-strand at 14 to 10 AWG; this size has a 15 mil PVC wall (0.381 mm) under a 4 mil nylon covering (0.102 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Tracer stripes are made at 14 to 10 AWG; this entry lists the solid colours only (game-design simplification). Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-2-0-stranded",
  "version": 1,
  "title": "2/0 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-2-0X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": -1,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.27,
    "jacketThicknessMm": 0.178,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 2/0 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 50 mil PVC wall (1.27 mm) under a 7 mil nylon covering (0.178 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-2-stranded",
  "version": 1,
  "title": "2 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-2X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 2,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.016,
    "jacketThicknessMm": 0.152,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 2 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 40 mil PVC wall (1.016 mm) under a 6 mil nylon covering (0.152 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-3-0-stranded",
  "version": 1,
  "title": "3/0 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-3-0X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": -2,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.27,
    "jacketThicknessMm": 0.178,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 3/0 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 50 mil PVC wall (1.27 mm) under a 7 mil nylon covering (0.178 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-4-0-stranded",
  "version": 1,
  "title": "4/0 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-4-0X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": -3,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.27,
    "jacketThicknessMm": 0.178,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 4/0 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 50 mil PVC wall (1.27 mm) under a 7 mil nylon covering (0.178 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-4-stranded",
  "version": 1,
  "title": "4 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-4X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 4,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 1.016,
    "jacketThicknessMm": 0.152,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 4 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 40 mil PVC wall (1.016 mm) under a 6 mil nylon covering (0.152 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-6-stranded",
  "version": 1,
  "title": "6 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-6X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 6,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": 0.127,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 6 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 30 mil PVC wall (0.762 mm) under a 5 mil nylon covering (0.127 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "conductor.tallowmere-thhn-8-stranded",
  "version": 1,
  "title": "8 AWG stranded copper THHN/THWN-2 building wire",
  "brand": "Tallowmere",
  "modelName": "TM-THHN-8X",
  "category": "conductor",
  "sizeMm": null,
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": {
    "awg": 8,
    "stranding": "stranded",
    "strandCount": 19,
    "material": {
      "table": "materials",
      "version": 1,
      "key": "copperAnnealed"
    },
    "insulation": {
      "table": "insulation",
      "version": 1,
      "key": "thhnThwn2"
    },
    "insulationThicknessMm": 0.762,
    "jacketThicknessMm": 0.127,
    "colours": [
      {
        "base": "black",
        "stripe": null
      },
      {
        "base": "white",
        "stripe": null
      },
      {
        "base": "red",
        "stripe": null
      },
      {
        "base": "blue",
        "stripe": null
      },
      {
        "base": "green",
        "stripe": null
      },
      {
        "base": "yellow",
        "stripe": null
      },
      {
        "base": "orange",
        "stripe": null
      },
      {
        "base": "brown",
        "stripe": null
      },
      {
        "base": "grey",
        "stripe": null
      },
      {
        "base": "purple",
        "stripe": null
      },
      {
        "base": "pink",
        "stripe": null
      }
    ]
  },
  "model": {
    "kind": "conductor",
    "params": {
      "layFactor": 1.02
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "thhn-construction",
      "kind": "real-world",
      "citation": "Typical published construction of 8 AWG THHN/THWN-2 (a US maker's public specification sheet, revised 02/2026, read; it carries no ampacity column; listed to UL 83, cited by number): made 19-strand from 8 AWG to 4/0; this size has a 30 mil PVC wall (0.762 mm) under a 5 mil nylon covering (0.127 mm), rounded from mils; colour-coded black, white, red, blue, green, yellow, orange, brown, grey, purple and pink (the sheet's tan has no colour id), most colours on all sizes. Rated 90 °C dry (THHN) and wet (THWN-2): the pinned insulation row thhnThwn2. Paraphrased; no table copied. The outer diameter is derived, never stored.",
      "covers": [
        "conductor.awg",
        "conductor.stranding",
        "conductor.strandCount",
        "conductor.insulation",
        "conductor.insulationThicknessMm",
        "conductor.jacketThicknessMm",
        "conductor.colours"
      ]
    },
    {
      "id": "copper-conductor",
      "kind": "real-world",
      "citation": "Soft (annealed) uncoated copper, as public THHN/THWN-2 and MTW sheets state for the conductor (concentric-stranded per ASTM B8; the standards cited by number, not read). Its resistivity, temperature coefficient and density are the pinned materials row copperAnnealed (100 % IACS, NBS Handbook 100). The area comes from the AWG definition (AWG_GAUGES), never from a conductor table.",
      "covers": [
        "conductor.material"
      ]
    },
    {
      "id": "stranding-lay-factor",
      "kind": "real-world",
      "citation": "A stranded conductor's resistance is its nominal area's times a lay factor of 1.02 for concentric Class B/C stranding up to 4/0 (NBS Handbook 100, Copper Wire Tables, 1966, its stranded-conductor tables and appendix; NBS Handbook 109, Aluminum Wire Tables, 1972, its twist factor of 1.02; both read in full in the P3 source pre-audit): the helical strands are longer than the conductor. Paraphrased; no table reproduced.",
      "covers": [
        "model.params.layFactor"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "connector.stavenor-emt-050",
  "version": 1,
  "title": "EMT set-screw connector, 1/2 in trade size",
  "brand": "Stavenor",
  "modelName": "SC-050",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 22,
    "heightMm": 28,
    "depthMm": 28
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitConnector",
    "params": {
      "tradeSizeIn": 0.5,
      "outsideDiameterMm": 17.93,
      "wallThicknessMm": 1.07,
      "throatLengthMm": 10
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1/2 trade size steel EMT, outside diameter 0.706 in = 17.93 mm, nominal wall 0.042 in = 1.07 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 18 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "connector-body",
      "kind": "game-design",
      "citation": "game-design within makers’ ranges: a steel set-screw EMT connector with a 22 mm body outside the enclosure wall (makers’ overall length less thread spans about 19 to 43 mm across the three sizes), 28 mm across (one maker lists 28.6, 35.1 and 41.4 mm), and a 10 mm threaded throat with its locknut inside the wall (makers list thread lengths of 9.5 to 14.3 mm); connector dimension sheets read 2026-11-12. The body’s length is a game-design pick inside those ranges.",
      "covers": [
        "sizeMm",
        "model.params.throatLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "connector.stavenor-emt-075",
  "version": 1,
  "title": "EMT set-screw connector, 3/4 in trade size",
  "brand": "Stavenor",
  "modelName": "SC-075",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 25,
    "heightMm": 34,
    "depthMm": 34
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitConnector",
    "params": {
      "tradeSizeIn": 0.75,
      "outsideDiameterMm": 23.42,
      "wallThicknessMm": 1.24,
      "throatLengthMm": 11
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 3/4 trade size steel EMT, outside diameter 0.922 in = 23.42 mm, nominal wall 0.049 in = 1.24 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 24 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "connector-body",
      "kind": "game-design",
      "citation": "game-design within makers’ ranges: a steel set-screw EMT connector with a 25 mm body outside the enclosure wall (makers’ overall length less thread spans about 19 to 43 mm across the three sizes), 34 mm across (one maker lists 28.6, 35.1 and 41.4 mm), and a 11 mm threaded throat with its locknut inside the wall (makers list thread lengths of 9.5 to 14.3 mm); connector dimension sheets read 2026-11-12. The body’s length is a game-design pick inside those ranges.",
      "covers": [
        "sizeMm",
        "model.params.throatLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "connector.stavenor-emt-100",
  "version": 1,
  "title": "EMT set-screw connector, 1 in trade size",
  "brand": "Stavenor",
  "modelName": "SC-100",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 28,
    "heightMm": 42,
    "depthMm": 42
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitConnector",
    "params": {
      "tradeSizeIn": 1,
      "outsideDiameterMm": 29.54,
      "wallThicknessMm": 1.45,
      "throatLengthMm": 12
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1 trade size steel EMT, outside diameter 1.163 in = 29.54 mm, nominal wall 0.057 in = 1.45 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 30 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "connector-body",
      "kind": "game-design",
      "citation": "game-design within makers’ ranges: a steel set-screw EMT connector with a 28 mm body outside the enclosure wall (makers’ overall length less thread spans about 19 to 43 mm across the three sizes), 42 mm across (one maker lists 28.6, 35.1 and 41.4 mm), and a 12 mm threaded throat with its locknut inside the wall (makers list thread lengths of 9.5 to 14.3 mm); connector dimension sheets read 2026-11-12. The body’s length is a game-design pick inside those ranges.",
      "covers": [
        "sizeMm",
        "model.params.throatLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "duct.lattisby-25x40",
  "version": 1,
  "title": "Slotted PVC wiring duct with cover, 25 × 40 mm, 2 m",
  "brand": "Lattisby",
  "modelName": "LD-2540",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 2000,
    "heightMm": 25,
    "depthMm": 40
  },
  "terminals": [],
  "mounts": [
    {
      "type": "backplate",
      "widthMm": 2000,
      "crossMm": 0
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.duct",
    "params": {
      "defaultLengthMm": 300,
      "minLengthMm": 20,
      "wallThicknessMm": 2,
      "slotWidthMm": 4,
      "fingerWidthMm": 6
    }
  },
  "controls": [
    {
      "id": "coverOn",
      "label": "Cover fitted",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "duct-section-class",
      "kind": "real-world",
      "citation": "real-world (product class): slotted PVC wiring duct is catalogued by several makers in width × height sections including 25 × 40, 40 × 60 and 60 × 80 mm, in 2 m lengths with a clip-on cover (makers’ datasheets, read 2026-11-12). This entry is the 25 × 40 mm section on 2000 mm stock. sizeMm: the stock length along +x, the width on the plate (+y), the height off it (+z).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "duct-comb",
      "kind": "real-world",
      "citation": "real-world (product class): makers publish a narrow slot pattern (4 mm slots between 6 mm fingers) and a wide one (8 mm slots between 12 mm fingers), with walls of about 2 mm (one maker’s drawing; 2.3 mm on another listing), datasheets read 2026-11-12. This section takes the narrow pattern and a 2 mm wall; which section gets which pattern is a game-design choice. Drawn, and read by F3.2 for the inside.",
      "covers": [
        "model.params.wallThicknessMm",
        "model.params.slotWidthMm",
        "model.params.fingerWidthMm"
      ]
    },
    {
      "id": "duct-cut",
      "kind": "game-design",
      "citation": "game-design: a new piece is cut to 300 mm (it fits the Pellmoor panel’s 350 mm backplate); raceway.cut makes pieces from 20 mm up to the 2 m stock length.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    },
    {
      "id": "duct-backplate",
      "kind": "game-design",
      "citation": "game-design: duct is screwed or riveted to a panel backplate (common practice), lying along the plate’s +x; its width along the mount is its cut length (the 2000 mm here is the stock, replaced by the cut).",
      "covers": [
        "fits.backplate"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "duct.lattisby-40x60",
  "version": 1,
  "title": "Slotted PVC wiring duct with cover, 40 × 60 mm, 2 m",
  "brand": "Lattisby",
  "modelName": "LD-4060",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 2000,
    "heightMm": 40,
    "depthMm": 60
  },
  "terminals": [],
  "mounts": [
    {
      "type": "backplate",
      "widthMm": 2000,
      "crossMm": 0
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.duct",
    "params": {
      "defaultLengthMm": 300,
      "minLengthMm": 20,
      "wallThicknessMm": 2,
      "slotWidthMm": 4,
      "fingerWidthMm": 6
    }
  },
  "controls": [
    {
      "id": "coverOn",
      "label": "Cover fitted",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "duct-section-class",
      "kind": "real-world",
      "citation": "real-world (product class): slotted PVC wiring duct is catalogued by several makers in width × height sections including 25 × 40, 40 × 60 and 60 × 80 mm, in 2 m lengths with a clip-on cover (makers’ datasheets, read 2026-11-12). This entry is the 40 × 60 mm section on 2000 mm stock. sizeMm: the stock length along +x, the width on the plate (+y), the height off it (+z).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "duct-comb",
      "kind": "real-world",
      "citation": "real-world (product class): makers publish a narrow slot pattern (4 mm slots between 6 mm fingers) and a wide one (8 mm slots between 12 mm fingers), with walls of about 2 mm (one maker’s drawing; 2.3 mm on another listing), datasheets read 2026-11-12. This section takes the narrow pattern and a 2 mm wall; which section gets which pattern is a game-design choice. Drawn, and read by F3.2 for the inside.",
      "covers": [
        "model.params.wallThicknessMm",
        "model.params.slotWidthMm",
        "model.params.fingerWidthMm"
      ]
    },
    {
      "id": "duct-cut",
      "kind": "game-design",
      "citation": "game-design: a new piece is cut to 300 mm (it fits the Pellmoor panel’s 350 mm backplate); raceway.cut makes pieces from 20 mm up to the 2 m stock length.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    },
    {
      "id": "duct-backplate",
      "kind": "game-design",
      "citation": "game-design: duct is screwed or riveted to a panel backplate (common practice), lying along the plate’s +x; its width along the mount is its cut length (the 2000 mm here is the stock, replaced by the cut).",
      "covers": [
        "fits.backplate"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "duct.lattisby-60x80",
  "version": 1,
  "title": "Slotted PVC wiring duct with cover, 60 × 80 mm, 2 m",
  "brand": "Lattisby",
  "modelName": "LD-6080",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 2000,
    "heightMm": 60,
    "depthMm": 80
  },
  "terminals": [],
  "mounts": [
    {
      "type": "backplate",
      "widthMm": 2000,
      "crossMm": 0
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.duct",
    "params": {
      "defaultLengthMm": 300,
      "minLengthMm": 20,
      "wallThicknessMm": 2,
      "slotWidthMm": 8,
      "fingerWidthMm": 12
    }
  },
  "controls": [
    {
      "id": "coverOn",
      "label": "Cover fitted",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "duct-section-class",
      "kind": "real-world",
      "citation": "real-world (product class): slotted PVC wiring duct is catalogued by several makers in width × height sections including 25 × 40, 40 × 60 and 60 × 80 mm, in 2 m lengths with a clip-on cover (makers’ datasheets, read 2026-11-12). This entry is the 60 × 80 mm section on 2000 mm stock. sizeMm: the stock length along +x, the width on the plate (+y), the height off it (+z).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "duct-comb",
      "kind": "real-world",
      "citation": "real-world (product class): makers publish a narrow slot pattern (4 mm slots between 6 mm fingers) and a wide one (8 mm slots between 12 mm fingers), with walls of about 2 mm (one maker’s drawing; 2.3 mm on another listing), datasheets read 2026-11-12. This section takes the wide pattern and a 2 mm wall; which section gets which pattern is a game-design choice. Drawn, and read by F3.2 for the inside.",
      "covers": [
        "model.params.wallThicknessMm",
        "model.params.slotWidthMm",
        "model.params.fingerWidthMm"
      ]
    },
    {
      "id": "duct-cut",
      "kind": "game-design",
      "citation": "game-design: a new piece is cut to 300 mm (it fits the Pellmoor panel’s 350 mm backplate); raceway.cut makes pieces from 20 mm up to the 2 m stock length.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    },
    {
      "id": "duct-backplate",
      "kind": "game-design",
      "citation": "game-design: duct is screwed or riveted to a panel backplate (common practice), lying along the plate’s +x; its width along the mount is its cut length (the 2000 mm here is the stock, replaced by the cut).",
      "covers": [
        "fits.backplate"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "elbow.stavenor-emt-050",
  "version": 1,
  "title": "EMT 90° elbow, 1/2 in trade size",
  "brand": "Stavenor",
  "modelName": "SE-050-90",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 175,
    "heightMm": 175,
    "depthMm": 18
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitElbow",
    "params": {
      "tradeSizeIn": 0.5,
      "outsideDiameterMm": 17.93,
      "wallThicknessMm": 1.07,
      "bendRadiusMm": 102,
      "legLengthMm": 64
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1/2 trade size steel EMT, outside diameter 0.706 in = 17.93 mm, nominal wall 0.042 in = 1.07 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 18 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "elbow-bend",
      "kind": "real-world",
      "citation": "real-world (product data): makers’ standard 90° steel EMT elbows for ANSI C80.3 / UL 797 tubing (cited by number) have a 102 mm centreline radius (4.00 in) and straight legs of 64 mm (2.5 in) at each end (makers’ elbow sheets, read 2026-11-12; a second maker gives 5.80 in for 1 in). Product data, not a code table of minimum bend radii; bends are not checked in P3.",
      "covers": [
        "model.params.bendRadiusMm",
        "model.params.legLengthMm"
      ]
    },
    {
      "id": "elbow-box",
      "kind": "game-design",
      "citation": "game-design: the elbow’s box is its leg plus its bend radius plus half its body diameter, square; its ends are on the box’s faces so joined parts touch.",
      "covers": [
        "sizeMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "elbow.stavenor-emt-075",
  "version": 1,
  "title": "EMT 90° elbow, 3/4 in trade size",
  "brand": "Stavenor",
  "modelName": "SE-075-90",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 190,
    "heightMm": 190,
    "depthMm": 24
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitElbow",
    "params": {
      "tradeSizeIn": 0.75,
      "outsideDiameterMm": 23.42,
      "wallThicknessMm": 1.24,
      "bendRadiusMm": 114,
      "legLengthMm": 64
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 3/4 trade size steel EMT, outside diameter 0.922 in = 23.42 mm, nominal wall 0.049 in = 1.24 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 24 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "elbow-bend",
      "kind": "real-world",
      "citation": "real-world (product data): makers’ standard 90° steel EMT elbows for ANSI C80.3 / UL 797 tubing (cited by number) have a 114 mm centreline radius (4.50 in) and straight legs of 64 mm (2.5 in) at each end (makers’ elbow sheets, read 2026-11-12; a second maker gives 5.80 in for 1 in). Product data, not a code table of minimum bend radii; bends are not checked in P3.",
      "covers": [
        "model.params.bendRadiusMm",
        "model.params.legLengthMm"
      ]
    },
    {
      "id": "elbow-box",
      "kind": "game-design",
      "citation": "game-design: the elbow’s box is its leg plus its bend radius plus half its body diameter, square; its ends are on the box’s faces so joined parts touch.",
      "covers": [
        "sizeMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "elbow.stavenor-emt-100",
  "version": 1,
  "title": "EMT 90° elbow, 1 in trade size",
  "brand": "Stavenor",
  "modelName": "SE-100-90",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 237,
    "heightMm": 237,
    "depthMm": 30
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduitElbow",
    "params": {
      "tradeSizeIn": 1,
      "outsideDiameterMm": 29.54,
      "wallThicknessMm": 1.45,
      "bendRadiusMm": 146,
      "legLengthMm": 76
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1 trade size steel EMT, outside diameter 1.163 in = 29.54 mm, nominal wall 0.057 in = 1.45 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 30 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "elbow-bend",
      "kind": "real-world",
      "citation": "real-world (product data): makers’ standard 90° steel EMT elbows for ANSI C80.3 / UL 797 tubing (cited by number) have a 146 mm centreline radius (5.75 in) and straight legs of 76 mm (3.0 in) at each end (makers’ elbow sheets, read 2026-11-12; a second maker gives 5.80 in for 1 in). Product data, not a code table of minimum bend radii; bends are not checked in P3.",
      "covers": [
        "model.params.bendRadiusMm",
        "model.params.legLengthMm"
      ]
    },
    {
      "id": "elbow-box",
      "kind": "game-design",
      "citation": "game-design: the elbow’s box is its leg plus its bend radius plus half its body diameter, square; its ends are on the box’s faces so joined parts touch.",
      "covers": [
        "sizeMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "emt.stavenor-050",
  "version": 1,
  "title": "EMT conduit, 1/2 in trade size, 10 ft stick",
  "brand": "Stavenor",
  "modelName": "SE-050",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 3048,
    "heightMm": 18,
    "depthMm": 18
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduit",
    "params": {
      "defaultLengthMm": 1000,
      "minLengthMm": 50,
      "tradeSizeIn": 0.5,
      "outsideDiameterMm": 17.93,
      "wallThicknessMm": 1.07
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1/2 trade size steel EMT, outside diameter 0.706 in = 17.93 mm, nominal wall 0.042 in = 1.07 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 18 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "emt-stick",
      "kind": "real-world",
      "citation": "real-world: EMT is sold in 10 ft (3048 mm) lengths (makers’ packaging tables, read 2026-11-12); sizeMm is the uncut stick along +x and the body diameter (18 mm). Cut ends are taken as square and reamed (no burr modelled).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "emt-cut",
      "kind": "game-design",
      "citation": "game-design: a new stick is cut to 1000 mm; raceway.cut makes pieces from 50 mm to the full stick.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "emt.stavenor-075",
  "version": 1,
  "title": "EMT conduit, 3/4 in trade size, 10 ft stick",
  "brand": "Stavenor",
  "modelName": "SE-075",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 3048,
    "heightMm": 24,
    "depthMm": 24
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduit",
    "params": {
      "defaultLengthMm": 1000,
      "minLengthMm": 50,
      "tradeSizeIn": 0.75,
      "outsideDiameterMm": 23.42,
      "wallThicknessMm": 1.24
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 3/4 trade size steel EMT, outside diameter 0.922 in = 23.42 mm, nominal wall 0.049 in = 1.24 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 24 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "emt-stick",
      "kind": "real-world",
      "citation": "real-world: EMT is sold in 10 ft (3048 mm) lengths (makers’ packaging tables, read 2026-11-12); sizeMm is the uncut stick along +x and the body diameter (24 mm). Cut ends are taken as square and reamed (no burr modelled).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "emt-cut",
      "kind": "game-design",
      "citation": "game-design: a new stick is cut to 1000 mm; raceway.cut makes pieces from 50 mm to the full stick.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "emt.stavenor-100",
  "version": 1,
  "title": "EMT conduit, 1 in trade size, 10 ft stick",
  "brand": "Stavenor",
  "modelName": "SE-100",
  "category": "raceway",
  "sizeMm": {
    "widthMm": 3048,
    "heightMm": 30,
    "depthMm": 30
  },
  "terminals": [],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "raceway.conduit",
    "params": {
      "defaultLengthMm": 1000,
      "minLengthMm": 50,
      "tradeSizeIn": 1,
      "outsideDiameterMm": 29.54,
      "wallThicknessMm": 1.45
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "emt-tube",
      "kind": "real-world",
      "citation": "real-world: 1 trade size steel EMT, outside diameter 1.163 in = 29.54 mm, nominal wall 0.057 in = 1.45 mm; steel-EMT makers’ published dimension tables for ANSI C80.3 / UL 797 tubing (cited by number), read 2026-11-12. No NEC Chapter 9 table is used. The body box rounds the diameter up to 30 mm (even, so the ends sit on whole millimetres).",
      "covers": [
        "model.params.tradeSizeIn",
        "model.params.outsideDiameterMm",
        "model.params.wallThicknessMm"
      ]
    },
    {
      "id": "emt-stick",
      "kind": "real-world",
      "citation": "real-world: EMT is sold in 10 ft (3048 mm) lengths (makers’ packaging tables, read 2026-11-12); sizeMm is the uncut stick along +x and the body diameter (30 mm). Cut ends are taken as square and reamed (no burr modelled).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "emt-cut",
      "kind": "game-design",
      "citation": "game-design: a new stick is cut to 1000 mm; raceway.cut makes pieces from 50 mm to the full stick.",
      "covers": [
        "model.params.defaultLengthMm",
        "model.params.minLengthMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "fuse.emberlyn-5x20-fa-1a",
  "version": 1,
  "title": "1 A fast-acting 5 × 20 mm fuse in an inline holder on a base",
  "brand": "Emberlyn",
  "modelName": "EF-520-1A",
  "category": "protection",
  "sizeMm": {
    "widthMm": 70,
    "heightMm": 30,
    "depthMm": 30
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 8,
        "y": 15,
        "z": 12
      },
      "methods": []
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 62,
        "y": 15,
        "z": 12
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "fuse",
    "params": {
      "ratedCurrentA": 1,
      "meltingI2tA2s": 0.7,
      "minimumFusingRatio": 1.2,
      "elementFraction": 0.3,
      "bodyTimeConstantS": 10,
      "resistanceOhm": 0.1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "fast-acting-5x20-class",
      "kind": "real-world",
      "citation": "The 1 A fast-acting 5 × 20 mm glass cartridge fuse, a common supplemental-protection class listed to UL 248-14. Typical published figures for the class, paraphrased (not one vendor's): a cold resistance of about 0.1 Ω and a nominal melting I²t of roughly 0.5 to 1 A²·s (0.7 A²·s is taken).",
      "covers": [
        "model.params.ratedCurrentA",
        "model.params.meltingI2tA2s",
        "model.params.resistanceOhm"
      ]
    },
    {
      "id": "opening-time-band",
      "kind": "game-design",
      "citation": "game-design inside UL 248-14's envelope for supplemental fuses (paraphrased): carries its rating, opens within an hour at 135 % and two minutes at 200 %. The fictional datasheet's band, tested: carries 110 %; 135 %: 1 s to 1 h; 200 %: 0.1 to 5 s; 1000 %: 1 to 20 ms. I_min of 1.2 × the rating, between 1 and 1.35 as the envelope requires.",
      "covers": [
        "model.params.minimumFusingRatio"
      ]
    },
    {
      "id": "two-body-melt",
      "kind": "game-design",
      "citation": "game-design: a fast element taking 30 % of the steady temperature rise inside a slow body (end caps and holder) of 10 s time constant, the element's own time constant (0.151 s) following from the melting I²t (electrical-realism-reviewer's worked example). It gives about 12 s at 135 %, 0.9 s at 200 % and 7 ms at 1000 %, near published fast-acting curves.",
      "covers": [
        "model.params.elementFraction",
        "model.params.bodyTimeConstantS"
      ]
    },
    {
      "id": "holder-layout",
      "kind": "game-design",
      "citation": "game-design: an inline fuse holder on a 70 × 30 mm base, 30 mm tall, with a screw terminal at each end; not modelled on a product. Replacing the fuse in P2 means deleting it and placing a new one.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "heater.hearthvale-120v-1500w",
  "version": 1,
  "title": "120 V 1500 W heater element on a base",
  "brand": "Hearthvale",
  "modelName": "HV-12015",
  "category": "load",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 120,
    "depthMm": 90
  },
  "terminals": [
    {
      "id": "a",
      "label": "L1",
      "positionMm": {
        "x": 20,
        "y": 60,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 10,
            "tolerance": 2
          },
          "torqueNm": 1.8,
          "drives": [
            "slotted",
            "phillips"
          ],
          "alRated": false,
          "entryMm": {
            "x": 0,
            "y": 60,
            "z": 30
          },
          "exitAxis": "-x",
          "clampType": "pressurePlate",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    },
    {
      "id": "b",
      "label": "L2",
      "positionMm": {
        "x": 380,
        "y": 60,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 10,
            "tolerance": 2
          },
          "torqueNm": 1.8,
          "drives": [
            "slotted",
            "phillips"
          ],
          "alRated": false,
          "entryMm": {
            "x": 400,
            "y": 60,
            "z": 30
          },
          "exitAxis": "+x",
          "clampType": "pressurePlate",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "heater",
    "params": {
      "ratedVoltageV": 120,
      "ratedPowerW": 1500
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "space-heater-class",
      "kind": "real-world",
      "citation": "The 120 V 1500 W resistance space-heater element, the usual top rating of NEC-region 120 V portable and small fixed heaters (makers' published ratings, typical figures, paraphrased, not one vendor's). Its resistance is V² / P = 14400 / 1500 = 9.6 Ω and its rated current P / V = 12.5 A. An 80/20 nickel-chromium element's resistance rises about 5 to 8 % from 20 °C to its working temperature; it is taken as constant at the rated (hot) value, an abstraction (the cold element draws that much more for its first moments).",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: the element in a guard on a 400 × 120 mm base, 90 mm tall, with a terminal at each end; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    },
    {
      "id": "heater-terminal-class",
      "kind": "game-design",
      "citation": "game-design: the element's two terminals are pressure-plate screw clamps, marked for one copper conductor of 14 to 10 AWG, solid or stranded (two fit, and the second makes a worse termination, D8), not for aluminium; the plate grips 8 mm of a 10 ± 2 mm strip, so every in-tolerance strip seats fully. The marked torque, 1.8 N·m (about 16 lb·in), is chosen inside the 14 to 18 lb·in range one maker publishes for lampholder terminal screws (read for the 120 V lamp's holder) and applied here as game-design; it is not a published heater figure. NFPA 70-2023 Art. 110.14(D) requires the marked value (cited by number); no UL 486A-B torque table is used. Not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors",
        "terminals.*.methods.screw.awgRange",
        "terminals.*.methods.screw.stranding",
        "terminals.*.methods.screw.stripLengthMm",
        "terminals.*.methods.screw.torqueNm",
        "terminals.*.methods.screw.alRated",
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm"
      ]
    },
    {
      "id": "heater-terminal-geometry",
      "kind": "game-design",
      "citation": "game-design: conductors reach each terminal from the base's end face and leave along ±x; not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "heater-screw-drives",
      "kind": "game-design",
      "citation": "game-design: a slotted and Phillips combination head (common practice, not one product); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "screw-terminal-contact",
      "kind": "game-design",
      "citation": "game-design: the screw-terminal class's R₀ applied to the heater's clamps. NBS Building Science Series 103 (W. J. Meese and R. W. Beausoliel, 1977; read in the P3 source pre-audit, ADR 0018 §4.1) measured good branch-circuit wiring-device screw terminals at 3 to 8 mV at 15 A, 0.2 to 0.5 mΩ; 0.3 mΩ is taken at the marked torque with a copper conductor at 20 °C. BSS 103 did not measure heater terminals.",
      "covers": [
        "terminals.*.methods.screw.contactOhm"
      ]
    },
    {
      "id": "screw-terminal-thermal",
      "kind": "game-design",
      "citation": "game-design calibration (ADR 0018 §3.3, §11), the screw-terminal class's values: the heat path into the device, 0.026 W/K, is calibrated, not measured (with 14 AWG copper at 15 A it puts BSS 103's 18 to 36 W glowing connections between the Draper point, about 525 °C, and about 1000 °C). The clamp's heat capacity, 1.1 J/K, is a physics estimate: about 3 g of brass clamp parts × about 380 J/(kg·K). The heater's own heat at its terminals is not modelled.",
      "covers": [
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "heater.hearthvale-12v-50w",
  "version": 1,
  "title": "12 V 50 W heater element on a base",
  "brand": "Hearthvale",
  "modelName": "HV-1250",
  "category": "load",
  "sizeMm": {
    "widthMm": 90,
    "heightMm": 50,
    "depthMm": 40
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 25,
        "z": 12
      },
      "methods": []
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 80,
        "y": 25,
        "z": 12
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "heater",
    "params": {
      "ratedVoltageV": 12,
      "ratedPowerW": 50
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "low-voltage-heater-class",
      "kind": "real-world",
      "citation": "The 12 V resistance heating element (vehicle and bench heaters, de-icing pads), commonly rated in watts at 12 V; 50 W is a usual rating of the class (typical published figures, paraphrased, not one vendor's). Its resistance is V² / P = 2.88 Ω. A nickel-chromium element's resistance rises only a few percent from cold to hot (a temperature coefficient of about 1e-4 per kelvin), so it is taken as constant at the rated (hot) value.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: the element in a guard on a 90 × 50 mm base, 40 mm tall, with a screw terminal at each end; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "lamp.lumivane-120v-60w",
  "version": 1,
  "title": "120 V 60 W incandescent lamp in a keyless holder on a base",
  "brand": "Lumivane",
  "modelName": "LV-120-60",
  "category": "load",
  "sizeMm": {
    "widthMm": 110,
    "heightMm": 110,
    "depthMm": 150
  },
  "terminals": [
    {
      "id": "a",
      "label": "BRASS",
      "positionMm": {
        "x": 15,
        "y": 55,
        "z": 20
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 14,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 16,
            "tolerance": 3
          },
          "torqueNm": 1.8,
          "drives": [
            "slotted",
            "phillips"
          ],
          "alRated": false,
          "entryMm": {
            "x": 0,
            "y": 55,
            "z": 20
          },
          "exitAxis": "-x",
          "clampType": "bindingScrew",
          "clampDepthMm": 12,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    },
    {
      "id": "b",
      "label": "SILVER",
      "positionMm": {
        "x": 95,
        "y": 55,
        "z": 20
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 14,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 16,
            "tolerance": 3
          },
          "torqueNm": 1.8,
          "drives": [
            "slotted",
            "phillips"
          ],
          "alRated": false,
          "entryMm": {
            "x": 110,
            "y": 55,
            "z": 20
          },
          "exitAxis": "+x",
          "clampType": "bindingScrew",
          "clampDepthMm": 12,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "lamp.incandescent",
    "params": {
      "ratedVoltageV": 120,
      "ratedPowerW": 60,
      "filamentRatedTempK": 2700,
      "thermalTimeConstantMs": 30,
      "conductionFraction": 0.05
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "general-service-lamp-class",
      "kind": "real-world",
      "citation": "The 120 V 60 W general-service incandescent lamp with a medium screw base, the common household lamp of NEC-region lighting circuits (lamp makers' catalogues, typical published ratings, paraphrased, not one vendor's). Its hot resistance is V² / P = 14400 / 60 = 240 Ω and its rated current P / V = 0.5 A.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "filament-temperature",
      "kind": "real-world",
      "citation": "L. L. Holladay, \"Proportion of energy radiated by incandescent solids in various spectral regions\", J. Opt. Soc. Am. 17 (1928), pp. 329–342, Table 5 (read 2026-11-12; its gas-filled rows were not independently verified by the realism review, which found them plausible), paraphrased: regular gas-filled tungsten lamps of 50 W and 75 W run their filaments at a maximum of about 2685 K and 2735 K; a 60 W lamp interpolates to about 2705 K, and 2700 K is taken (the rounding is game-design). With tungsten's resistivity (Jones and Langmuir, 1927) it gives a cold resistance of 240 × 5.4849 / 81.095 = 16.23 Ω at 20 °C, 1/14.79 of the hot one, where the cold-start inrush comes from.",
      "covers": [
        "model.params.filamentRatedTempK"
      ]
    },
    {
      "id": "inrush-band",
      "kind": "real-world",
      "citation": "Physics from H. A. Jones and I. Langmuir, General Electric Review 30 (1927): a filament's cold-to-hot resistance ratio is ρ(T_r)/ρ(T_a), 13.5 to 16.1 for rated temperatures of 2500 to 2900 K at a 293 K ambient; 14.79 at this lamp's 2700 K. Source impedance and the wiring in series lower the current ratio, so the tested inrush band is 10 to 15 times the settled current.",
      "covers": [
        "model.params.filamentRatedTempK"
      ]
    },
    {
      "id": "filament-time-constant",
      "kind": "real-world",
      "citation": "Physics estimate (P3 decision D17, the τ ≈ 30 ms the realism review recommended in P2), recomputed in lamp-120v.spec.ts: a straight tungsten wire that radiates 95 % of 60 W at 2700 K with a total emissivity of about 0.317 (Holladay 1928, Table 3: 0.311 at 2600 K, 0.323 at 2800 K; not independently verified by the realism review, plausible) and has 240 Ω there (ρ = 81.095 µΩ·cm, Jones and Langmuir) is about 43 µm × 440 mm, 12.5 mg at 19.3 g/cm³; with tungsten's heat capacity at 2700 K (36.19 J/(mol·K), NIST-JANAF table for crystalline tungsten, read 2026-11-12; 0.197 J/(g·K)) that is 2.46 mJ/K against a loss slope of 0.0857 W/K, τ ≈ 29 ms. A coiled filament's self-shading lengthens the wire and raises it (about 33 ms if 90 % of its surface radiates freely). 30 ms is taken; the model's heat capacity is then 2.57 mJ/K.",
      "covers": [
        "model.params.thermalTimeConstantMs"
      ]
    },
    {
      "id": "conduction-fraction",
      "kind": "game-design",
      "citation": "game-design inside published behaviour (P3 decision D17, paired with the 30 ms time constant as the realism review recommended in P2): 5 % of the rated power is lost by conduction at the rated point, the rest radiated. The model's light fits the published L ∝ V^3.4 (Fink and Beaty) best near 5 %. A long 120 V filament's end loss into its lead-ins is smaller than the bench lamp's (Langmuir, MacLane and Blodgett, Phys. Rev. 35, 1930: end losses are largest for short, thick, low-voltage filaments), and a gas-filled lamp also loses heat to its gas, which the vacuum model doesn't carry; the one linear term stands in for both. With it a switched-off filament's tail time constant is C / G = 2.57 mJ/K / 1.246 mW/K ≈ 2.1 s.",
      "covers": [
        "model.params.conductionFraction"
      ]
    },
    {
      "id": "holder-layout",
      "kind": "game-design",
      "citation": "game-design: the lamp stands in a keyless porcelain holder on a 110 × 110 mm base, 150 mm tall with the lamp, with the brass (line) screw on one side and the silver (neutral) screw on the other; a stand-in for P4's lampholders and boxes (D12), not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    },
    {
      "id": "holder-terminal-torque",
      "kind": "game-design",
      "citation": "game-design anchored to a published figure: one lampholder maker's product pages (several of its medium-base incandescent lampholders with terminal screws) give a terminal-screw torque range of 14 to 18 lb·in (1.6 to 2.0 N·m) (read 2026-11-12, paraphrased, the maker not named). That range is applied here as game-design: the fictional holder is marked 1.8 N·m (about 16 lb·in), inside it; NFPA 70-2023 Art. 110.14(D) requires the marked value (cited by number). No UL 486A-B torque table is used.",
      "covers": [
        "terminals.*.methods.screw.torqueNm"
      ]
    },
    {
      "id": "holder-terminal-class",
      "kind": "game-design",
      "citation": "game-design: the holder's side-wired binding-head screws take one copper conductor each, 14 or 12 AWG, solid or stranded, wrapped clockwise under the head; not marked for aluminium. Stranded copper under a binding head splays (ADR 0018 §4.3). The 16 ± 3 mm strip wraps about three-quarters of a turn round the screw, and the head grips 12 mm of it. Usual for wiring-device side terminals, not published figures read for this entry.",
      "covers": [
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors",
        "terminals.*.methods.screw.awgRange",
        "terminals.*.methods.screw.stranding",
        "terminals.*.methods.screw.stripLengthMm",
        "terminals.*.methods.screw.alRated",
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm"
      ]
    },
    {
      "id": "holder-terminal-geometry",
      "kind": "game-design",
      "citation": "game-design: conductors reach each screw from the base's side face and leave along ±x; not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "holder-screw-drives",
      "kind": "game-design",
      "citation": "game-design: a slotted and Phillips combination head, common on wiring-device terminal screws (common practice, not one product); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "screw-terminal-contact",
      "kind": "real-world",
      "citation": "NBS Building Science Series 103 (W. J. Meese and R. W. Beausoliel, 1977; read in the P3 source pre-audit, ADR 0018 §4.1): good branch-circuit wiring-device screw-terminal connections dropped 3 to 8 mV at 15 A, 0.2 to 0.5 mΩ. The class value 0.3 mΩ is taken as R₀, the contact resistance at the marked torque with a copper conductor at 20 °C; the engine scales it for torque, strip length, conductor count, strand spread and nicks (ADR 0018 §4).",
      "covers": [
        "terminals.*.methods.screw.contactOhm"
      ]
    },
    {
      "id": "screw-terminal-thermal",
      "kind": "game-design",
      "citation": "game-design calibration (ADR 0018 §3.3, §11), the screw-terminal class's values: the heat path into the device, 0.026 W/K, is calibrated, not measured (with 14 AWG copper at 15 A it puts BSS 103's 18 to 36 W glowing connections between the Draper point, about 525 °C, and about 1000 °C); a porcelain holder conducts less than a breaker's body, which the class value doesn't distinguish. The clamp's heat capacity, 1.1 J/K, is a physics estimate: about 3 g of brass screw and terminal plate × about 380 J/(kg·K).",
      "covers": [
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
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
      },
      "methods": []
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 40,
        "y": 25,
        "z": 12
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "lamp.incandescent",
    "params": {
      "ratedVoltageV": 12,
      "ratedPowerW": 5,
      "filamentRatedTempK": 2700,
      "thermalTimeConstantMs": 50
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
      "id": "filament-temperature",
      "kind": "game-design",
      "citation": "game-design inside published behaviour: small low-voltage vacuum signal lamps run their tungsten filaments at roughly 2500 to 2900 K (lamp makers' miniature-lamp catalogues give colour temperatures in that range; a household 100 W lamp runs nearer 2850 K). 2700 K is taken. With tungsten's resistivity (Jones and Langmuir, 1927) it gives the lamp a cold resistance of about 1/15 of its hot one, which is where the cold-start inrush comes from.",
      "covers": [
        "model.params.filamentRatedTempK"
      ]
    },
    {
      "id": "filament-time-constant",
      "kind": "game-design",
      "citation": "game-design inside published behaviour: a small signal lamp's filament heats and cools in tens of milliseconds, its inrush decaying over a few tens of milliseconds. 50 ms is taken as the small-signal thermal time constant at the rated point. With the engine-6 lamp model it implies a heat capacity of about 0.34 mJ/K, where a physics estimate for a W5W filament gives about 0.17 to 0.27 mJ/K (a time constant of about 24 to 39 ms): 50 ms is at the slow end, kept so the bench demo keeps its meaning (P3 decision D17); the 120 V lamp uses the recalibrated pairing.",
      "covers": [
        "model.params.thermalTimeConstantMs"
      ]
    },
    {
      "id": "inrush-band",
      "kind": "real-world",
      "citation": "Physics from H. A. Jones and I. Langmuir, General Electric Review 30 (1927): a filament's cold-to-hot resistance ratio is ρ(T_r)/ρ(T_a), 13.5 to 16.1 for rated temperatures of 2500 to 2900 K at a 293 K ambient. The source and lead resistance in series lower the current ratio, so the tested inrush band is 10 to 15 times the settled current.",
      "covers": [
        "model.params.filamentRatedTempK"
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
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "lead",
    "params": {
      "lengthMm": 1000,
      "conductorAreaM2": 8.2305e-7,
      "resistivityOhmM": 1.724137931034483e-8,
      "temperatureCoefficientPerK": 0.00393,
      "referenceTemperatureK": 293.15,
      "contactResistanceOhm": 0.01,
      "linearAlphaMaxK": 473.15,
      "densityKgM3": 8890,
      "specificHeatJPerKgK": 385,
      "insulationThicknessMm": 0.8,
      "insulationConductivityWPerMK": 0.18,
      "surfaceEmissivity": 0.9,
      "meltingPointK": 1357.77,
      "insulationRatedTempK": 363.15
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "annealed-copper-standard",
      "kind": "real-world",
      "citation": "International Annealed Copper Standard (adopted by the IEC in 1913, published as IEC 60028, whose 1925 edition is a revision): annealed copper has a resistivity of 1/58 Ω·mm²/m (1.7241 × 10⁻⁸ Ω·m) at 20 °C (293.15 K), and a temperature coefficient of resistance of 0.00393 per kelvin at 20 °C. The lead's resistance is computed from these (resistivity × length ÷ area, with the temperature coefficient), never taken from a conductor table.",
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
    },
    {
      "id": "copper-thermal-data",
      "kind": "real-world",
      "citation": "The lead's copper, as the materials table's annealed-copper row cites it (F3.6 part 1, ADR 0018 §8): NBS Handbook 100, Copper Wire Tables (1966, read in full by electrical-realism-reviewer), a density of 8.89 g/cm³ and resistance linear in temperature up to 200 °C (473.15 K), where the engine clamps R(T); a specific heat of 385 J/(kg·K) near 25 °C from the NIST-JANAF Thermochemical Tables (Chase, 4th ed., 1998) through the NIST Chemistry WebBook's Shomate fit (24.47 J/(mol·K) ÷ 63.546 g/mol). Paraphrased; no table reproduced.",
      "covers": [
        "model.params.linearAlphaMaxK",
        "model.params.densityKgM3",
        "model.params.specificHeatJPerKgK"
      ]
    },
    {
      "id": "pvc-insulation-thermal-data",
      "kind": "real-world",
      "citation": "The lead's PVC insulation, as the insulation table cites it (ADR 0018 §8): a thermal conductivity of 0.18 W/(m·K), mid-band of PVC's 0.16 to 0.20 W/(m·K) from a plastics distributor's published thermal-property table (read by electrical-realism-reviewer in the P3 source pre-audit), and the table's game-design surface emissivity of 0.9 (an infrared-thermometer maker's table gives about 0.93 for PVC). Paraphrased.",
      "covers": [
        "model.params.insulationConductivityWPerMK",
        "model.params.surfaceEmissivity"
      ]
    },
    {
      "id": "lead-insulation-wall",
      "kind": "game-design",
      "citation": "game-design, anchored to the 600 V PVC hookup-wire wall, about 0.8 mm for 18 AWG in manufacturers' public sheets (no single maker): one PVC layer; the lead's thermal model takes the conductor solid-round at its nominal area.",
      "covers": [
        "model.params.insulationThicknessMm"
      ]
    },
    {
      "id": "copper-melting-point",
      "kind": "real-world",
      "citation": "The copper freezing point of the International Temperature Scale of 1990, 1357.77 K (H. Preston-Thomas, Metrologia 27, 1990), as the materials table's copper row, confirmed by electrical-realism-reviewer 2026-11-12 against the ITS-90 fixed points (Preston-Thomas, Metrologia 27, 1990). The lead fuses, open for good, when its conductor node reaches it (F3.6 part 2). Cross-checked against Preece's fusing law for bare copper in air, I = 80 d^1.5 A (d in mm), 82.9 A for 18 AWG: the model's steady state reaches the melting point at about 103 A, 24 % above it, because R(T) is clamped at 200 °C (ADR 0018 §2), so fusing comes late: a sustained 83 to 100 A on this 18 AWG lead survives in the model, where a real lead would likely fuse.",
      "covers": [
        "model.params.meltingPointK"
      ]
    },
    {
      "id": "lead-insulation-rating",
      "kind": "game-design",
      "citation": "game-design: the lead's single PVC wall is taken at the insulation table's PVC machine-tool-wire rating, 90 °C dry (UL 1063 by number; the table's ul-type-ratings source); retail test-lead insulation ranges from about 60 °C (PVC) to 200 °C (silicone), and none is cited. The lead's insulationDamaged flag is set at this rating plus INSULATION_DAMAGE_MARGIN_K (40 K), as a conductor's (F3.6 part 2).",
      "covers": [
        "model.params.insulationRatedTempK"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "panel.pellmoor-din-400x500",
  "version": 1,
  "title": "Steel panel enclosure, 400 × 500 × 200 mm, backplate and two DIN rails",
  "brand": "Pellmoor",
  "modelName": "PM-4520-D",
  "category": "enclosure",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 500,
    "depthMm": 200
  },
  "terminals": [],
  "mounts": [],
  "enclosure": {
    "mounts": [
      {
        "id": "rail-1",
        "type": "din35",
        "positionMm": {
          "x": 35,
          "y": 305,
          "z": 22
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 330
      },
      {
        "id": "rail-2",
        "type": "din35",
        "positionMm": {
          "x": 35,
          "y": 130,
          "z": 22
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 330
      },
      {
        "id": "plate",
        "type": "backplate",
        "positionMm": {
          "x": 25,
          "y": 25,
          "z": 14
        },
        "axis": "+x",
        "facing": "+z",
        "extentMm": 350
      }
    ],
    "entries": [
      {
        "id": "ko-bottom-1",
        "type": "knockout",
        "tradeSize": "3/4",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 100,
          "y": 0,
          "z": 100
        },
        "axis": "+y"
      },
      {
        "id": "ko-bottom-2",
        "type": "knockout",
        "tradeSize": "3/4",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 200,
          "y": 0,
          "z": 100
        },
        "axis": "+y"
      },
      {
        "id": "ko-bottom-3",
        "type": "knockout",
        "tradeSize": "1",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 300,
          "y": 0,
          "z": 100
        },
        "axis": "+y"
      },
      {
        "id": "drill-top-1",
        "type": "drillSite",
        "tradeSize": "3/4",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 130,
          "y": 500,
          "z": 100
        },
        "axis": "-y"
      },
      {
        "id": "drill-top-2",
        "type": "drillSite",
        "tradeSize": "3/4",
        "maxCables": 1,
        "internalClamp": false,
        "positionMm": {
          "x": 270,
          "y": 500,
          "z": 100
        },
        "axis": "-y"
      }
    ],
    "interiorVolumeMm3": 38890368
  },
  "conductor": null,
  "model": {
    "kind": "enclosure.panel",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "enclosure-class",
      "kind": "real-world",
      "citation": "real-world (product class): 400 × 500 × 200 mm single-door wall-mount sheet-steel enclosures are catalogued by several makers with 1.5 mm body steel, UL Type 1/3R/4/12 ratings (UL 50/50E, NEMA 250 by number) and a 350 × 450 mm mounting plate of 2–2.5 mm galvanised steel; distributor listings read 2026-11-12. Drawn walls 2 mm (rounded up), so the inside is 396 × 496 × 198 mm. The door is not modelled (the front is open).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "interior-volume",
      "kind": "game-design",
      "citation": "game-design: computed from the inside dimensions above as a plain rectangular volume, 396 × 496 × 198 = 38890368 mm³. Box fill (P4) doesn't apply to a panel enclosure; it is stored for completeness and is not from any code table.",
      "covers": [
        "interiorVolumeMm3"
      ]
    },
    {
      "id": "rail-profile",
      "kind": "real-world",
      "citation": "real-world: the 35 mm top-hat rail TS 35 × 7.5 (IEC 60715, cited by number), 7.5 mm deep (drawn 8 mm, so a device clipped on clears it), and the 90 mm overall height (45 mm front) of modular devices (DIN 43880, cited by number): a mounted device's bottom edge sits 45 mm below the rail centreline, so a 90 mm device is centred on its rail and others sit off-centre (ADR 0015's mount origin).",
      "covers": [
        "mounts.rail-1",
        "mounts.rail-2"
      ]
    },
    {
      "id": "rail-layout",
      "kind": "game-design",
      "citation": "game-design: the rails are 330 mm long from x = 35 mm, their centrelines 350 and 175 mm above the enclosure's bottom, screwed to the backplate (front face at z = 14 mm), so a device's back is at z = 22 mm; not taken from a product drawing.",
      "covers": [
        "mounts.rail-1",
        "mounts.rail-2"
      ]
    },
    {
      "id": "backplate",
      "kind": "game-design",
      "citation": "game-design: a 350 × 450 mm backplate (mounting plate), 2 mm thick (2–2.5 mm in the class), standing 10 mm off the inside face of the back wall on studs; parts may be fixed anywhere on a 350 mm square of it from its lower-left corner (an area mount is a square until a backplate declares its second extent, ADR 0015 implementation note 7). The rails are drawn on it but are not bodies: a part fixed to the plate over a rail is not refused.",
      "covers": [
        "mounts.plate"
      ]
    },
    {
      "id": "entry-layout",
      "kind": "game-design",
      "citation": "game-design: two 3/4 in and one 1 in trade-size knockouts in the bottom, and two drill sites for 3/4 in connectors in the top (opened with a hole saw or punch, F3.4 part 2), one connector each; positions are on the outside wall faces and are not taken from a product drawing.",
      "covers": [
        "entries.ko-bottom-1",
        "entries.ko-bottom-2",
        "entries.ko-bottom-3",
        "entries.drill-top-1",
        "entries.drill-top-2"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "resistor.orrinwood-10r-10w",
  "version": 1,
  "title": "10 Ω 10 W power resistor on a base",
  "brand": "Orrinwood",
  "modelName": "OW-10R-10",
  "category": "load",
  "sizeMm": {
    "widthMm": 70,
    "heightMm": 40,
    "depthMm": 30
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 8,
        "y": 20,
        "z": 12
      },
      "methods": []
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 62,
        "y": 20,
        "z": 12
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "resistor",
    "params": {
      "resistanceOhm": 10,
      "powerRatingW": 10
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "power-resistor-class",
      "kind": "real-world",
      "citation": "The aluminium-housed wirewound power resistor, a common bench and panel class: 10 Ω in the E-series of preferred values, rated 10 W when mounted on a heat sink (typical published figures for the class, paraphrased, not one vendor's). Its resistance is taken as exact and constant; P2 has no tolerance, temperature coefficient or damage model.",
      "covers": [
        "model.params.resistanceOhm",
        "model.params.powerRatingW"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: the resistor on a 70 × 40 mm base, 30 mm tall, with a screw terminal at each end; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "splice.corvelle-tw-l",
  "version": 1,
  "title": "Twist-on wire connector, large (14 to 10 AWG, 2 to 5 conductors)",
  "brand": "Corvelle",
  "modelName": "TW-L",
  "category": "splice",
  "sizeMm": {
    "widthMm": 24,
    "heightMm": 34,
    "depthMm": 24
  },
  "terminals": [
    {
      "id": "splice",
      "label": "SPLICE",
      "positionMm": {
        "x": 12,
        "y": 0,
        "z": 12
      },
      "methods": [
        {
          "method": "twistOn",
          "ratedConductors": 5,
          "maxConductors": 5,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": null,
          "drives": [],
          "alRated": false,
          "entryMm": {
            "x": 12,
            "y": 0,
            "z": 12
          },
          "exitAxis": "-y",
          "clampType": "twistOn",
          "clampDepthMm": 11,
          "contactOhm": 0.0005,
          "heatPathWPerK": 0.01,
          "hotSpotHeatCapacityJPerK": 1,
          "combination": {
            "minConductors": 2,
            "maxConductors": 5,
            "awg": {
              "smallest": 14,
              "largest": 10
            },
            "totalAreaUm2": {
              "min": 4161820,
              "max": 16543850
            }
          }
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "splice.twistOn",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "twist-on-class",
      "kind": "game-design",
      "citation": "game-design, inside the general class of UL 486C-listed twist-on connectors (cited by number; the standard was not read): makers sell them in a few colour-coded sizes, each rated for a count range and a size range of copper conductors, stripped about 1/2 in. This fictional large size takes 2 to 5 copper conductors of 14 to 10 AWG, solid or stranded, not aluminium, with a combined size from 14 + 14 AWG (4161820 µm²) to 12 + 12 + 12 + 12 + 12 AWG (16543850 µm², from the gauge table's areaUm2). The bounds are a paraphrased, simplified envelope chosen for play: no maker's combination chart was read or reproduced, so they are labelled game-design until one is read (ADR 0018 §4.4). The 13 ± 2 mm strip and 11 mm of twisted engagement are game-design too.",
      "covers": [
        "terminals.splice.methods.twistOn.ratedConductors",
        "terminals.splice.methods.twistOn.maxConductors",
        "terminals.splice.methods.twistOn.awgRange",
        "terminals.splice.methods.twistOn.stranding",
        "terminals.splice.methods.twistOn.stripLengthMm",
        "terminals.splice.methods.twistOn.alRated",
        "terminals.splice.methods.twistOn.clampType",
        "terminals.splice.methods.twistOn.clampDepthMm",
        "terminals.splice.methods.twistOn.combination"
      ]
    },
    {
      "id": "twist-on-contact",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §4.1, §11): R₀ = 0.5 mΩ for a twist-on joint, between the spring cage (0.3 mΩ) and the back-stab (1.0 mΩ), within NBS Building Science Series 128's (1980, read in the P3 pre-audit) 1.5 mΩ acceptance limit for an assembled connection. Every landed conductor gets it with a fixed spring force (r = 1), scaled only by strip length, nicks and the metal (ADR 0018 §4.4).",
      "covers": [
        "terminals.splice.methods.twistOn.contactOhm"
      ]
    },
    {
      "id": "twist-on-thermal",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §3.3; F3.6 reads them): the joint sits inside an insulating shell, so its heat path to the device (taken at ambient) is small, 0.01 W/K, against the screw class's 0.026 W/K; the clamp's heat capacity is a physics estimate, about 2 g of steel spring and the twisted copper ends × about 450 J/(kg·K), rounded to 1 J/K.",
      "covers": [
        "terminals.splice.methods.twistOn.heatPathWPerK",
        "terminals.splice.methods.twistOn.hotSpotHeatCapacityJPerK"
      ]
    },
    {
      "id": "twist-on-body",
      "kind": "game-design",
      "citation": "game-design: a 24 × 34 × 24 mm tapered shell with its one splice terminal at the open end, conductors entering along −y; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals",
        "terminals.splice.methods.twistOn.entryMm",
        "terminals.splice.methods.twistOn.exitAxis"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "splice.corvelle-tw-m",
  "version": 1,
  "title": "Twist-on wire connector, medium (18 to 12 AWG, 2 to 4 conductors)",
  "brand": "Corvelle",
  "modelName": "TW-M",
  "category": "splice",
  "sizeMm": {
    "widthMm": 20,
    "heightMm": 28,
    "depthMm": 20
  },
  "terminals": [
    {
      "id": "splice",
      "label": "SPLICE",
      "positionMm": {
        "x": 10,
        "y": 0,
        "z": 10
      },
      "methods": [
        {
          "method": "twistOn",
          "ratedConductors": 4,
          "maxConductors": 4,
          "awgRange": {
            "smallest": 18,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": null,
          "drives": [],
          "alRated": false,
          "entryMm": {
            "x": 10,
            "y": 0,
            "z": 10
          },
          "exitAxis": "-y",
          "clampType": "twistOn",
          "clampDepthMm": 11,
          "contactOhm": 0.0005,
          "heatPathWPerK": 0.01,
          "hotSpotHeatCapacityJPerK": 1,
          "combination": {
            "minConductors": 2,
            "maxConductors": 4,
            "awg": {
              "smallest": 18,
              "largest": 12
            },
            "totalAreaUm2": {
              "min": 1646094,
              "max": 9926310
            }
          }
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "splice.twistOn",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "twist-on-class",
      "kind": "game-design",
      "citation": "game-design, inside the general class of UL 486C-listed twist-on connectors (cited by number; the standard was not read): makers sell them in a few colour-coded sizes, each rated for a count range and a size range of copper conductors, stripped about 1/2 in. This fictional medium size takes 2 to 4 copper conductors of 18 to 12 AWG, solid or stranded, not aluminium, with a combined size from 18 + 18 AWG (1646094 µm²) to 12 + 12 + 12 AWG (9926310 µm², from the gauge table's areaUm2). The bounds are a paraphrased, simplified envelope chosen for play: no maker's combination chart was read or reproduced, so they are labelled game-design until one is read (ADR 0018 §4.4). The 13 ± 2 mm strip and 11 mm of twisted engagement are game-design too.",
      "covers": [
        "terminals.splice.methods.twistOn.ratedConductors",
        "terminals.splice.methods.twistOn.maxConductors",
        "terminals.splice.methods.twistOn.awgRange",
        "terminals.splice.methods.twistOn.stranding",
        "terminals.splice.methods.twistOn.stripLengthMm",
        "terminals.splice.methods.twistOn.alRated",
        "terminals.splice.methods.twistOn.clampType",
        "terminals.splice.methods.twistOn.clampDepthMm",
        "terminals.splice.methods.twistOn.combination"
      ]
    },
    {
      "id": "twist-on-contact",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §4.1, §11): R₀ = 0.5 mΩ for a twist-on joint, between the spring cage (0.3 mΩ) and the back-stab (1.0 mΩ), within NBS Building Science Series 128's (1980, read in the P3 pre-audit) 1.5 mΩ acceptance limit for an assembled connection. Every landed conductor gets it with a fixed spring force (r = 1), scaled only by strip length, nicks and the metal (ADR 0018 §4.4).",
      "covers": [
        "terminals.splice.methods.twistOn.contactOhm"
      ]
    },
    {
      "id": "twist-on-thermal",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §3.3; F3.6 reads them): the joint sits inside an insulating shell, so its heat path to the device (taken at ambient) is small, 0.01 W/K, against the screw class's 0.026 W/K; the clamp's heat capacity is a physics estimate, about 2 g of steel spring and the twisted copper ends × about 450 J/(kg·K), rounded to 1 J/K.",
      "covers": [
        "terminals.splice.methods.twistOn.heatPathWPerK",
        "terminals.splice.methods.twistOn.hotSpotHeatCapacityJPerK"
      ]
    },
    {
      "id": "twist-on-body",
      "kind": "game-design",
      "citation": "game-design: a 20 × 28 × 20 mm tapered shell with its one splice terminal at the open end, conductors entering along −y; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals",
        "terminals.splice.methods.twistOn.entryMm",
        "terminals.splice.methods.twistOn.exitAxis"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "splice.corvelle-tw-s",
  "version": 1,
  "title": "Twist-on wire connector, small (22 to 14 AWG, 2 to 3 conductors)",
  "brand": "Corvelle",
  "modelName": "TW-S",
  "category": "splice",
  "sizeMm": {
    "widthMm": 16,
    "heightMm": 22,
    "depthMm": 16
  },
  "terminals": [
    {
      "id": "splice",
      "label": "SPLICE",
      "positionMm": {
        "x": 8,
        "y": 0,
        "z": 8
      },
      "methods": [
        {
          "method": "twistOn",
          "ratedConductors": 3,
          "maxConductors": 3,
          "awgRange": {
            "smallest": 22,
            "largest": 14
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": null,
          "drives": [],
          "alRated": false,
          "entryMm": {
            "x": 8,
            "y": 0,
            "z": 8
          },
          "exitAxis": "-y",
          "clampType": "twistOn",
          "clampDepthMm": 11,
          "contactOhm": 0.0005,
          "heatPathWPerK": 0.01,
          "hotSpotHeatCapacityJPerK": 1,
          "combination": {
            "minConductors": 2,
            "maxConductors": 3,
            "awg": {
              "smallest": 22,
              "largest": 14
            },
            "totalAreaUm2": {
              "min": 651068,
              "max": 4161820
            }
          }
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "splice.twistOn",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "twist-on-class",
      "kind": "game-design",
      "citation": "game-design, inside the general class of UL 486C-listed twist-on connectors (cited by number; the standard was not read): makers sell them in a few colour-coded sizes, each rated for a count range and a size range of copper conductors, stripped about 1/2 in. This fictional small size takes 2 to 3 copper conductors of 22 to 14 AWG, solid or stranded, not aluminium, with a combined size from 22 + 22 AWG (651068 µm²) to 14 + 14 AWG (4161820 µm², from the gauge table's areaUm2). The bounds are a paraphrased, simplified envelope chosen for play: no maker's combination chart was read or reproduced, so they are labelled game-design until one is read (ADR 0018 §4.4). The 13 ± 2 mm strip and 11 mm of twisted engagement are game-design too.",
      "covers": [
        "terminals.splice.methods.twistOn.ratedConductors",
        "terminals.splice.methods.twistOn.maxConductors",
        "terminals.splice.methods.twistOn.awgRange",
        "terminals.splice.methods.twistOn.stranding",
        "terminals.splice.methods.twistOn.stripLengthMm",
        "terminals.splice.methods.twistOn.alRated",
        "terminals.splice.methods.twistOn.clampType",
        "terminals.splice.methods.twistOn.clampDepthMm",
        "terminals.splice.methods.twistOn.combination"
      ]
    },
    {
      "id": "twist-on-contact",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §4.1, §11): R₀ = 0.5 mΩ for a twist-on joint, between the spring cage (0.3 mΩ) and the back-stab (1.0 mΩ), within NBS Building Science Series 128's (1980, read in the P3 pre-audit) 1.5 mΩ acceptance limit for an assembled connection. Every landed conductor gets it with a fixed spring force (r = 1), scaled only by strip length, nicks and the metal (ADR 0018 §4.4).",
      "covers": [
        "terminals.splice.methods.twistOn.contactOhm"
      ]
    },
    {
      "id": "twist-on-thermal",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §3.3; F3.6 reads them): the joint sits inside an insulating shell, so its heat path to the device (taken at ambient) is small, 0.01 W/K, against the screw class's 0.026 W/K; the clamp's heat capacity is a physics estimate, about 2 g of steel spring and the twisted copper ends × about 450 J/(kg·K), rounded to 1 J/K.",
      "covers": [
        "terminals.splice.methods.twistOn.heatPathWPerK",
        "terminals.splice.methods.twistOn.hotSpotHeatCapacityJPerK"
      ]
    },
    {
      "id": "twist-on-body",
      "kind": "game-design",
      "citation": "game-design: a 16 × 22 × 16 mm tapered shell with its one splice terminal at the open end, conductors entering along −y; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals",
        "terminals.splice.methods.twistOn.entryMm",
        "terminals.splice.methods.twistOn.exitAxis"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "supply.brindlecore-bench-30v-5a",
  "version": 1,
  "title": "0–30 V 0–5 A bench DC power supply",
  "brand": "Brindlecore",
  "modelName": "BX-217",
  "category": "source",
  "sizeMm": {
    "widthMm": 130,
    "heightMm": 270,
    "depthMm": 160
  },
  "terminals": [
    {
      "id": "neg",
      "label": "−",
      "positionMm": {
        "x": 56,
        "y": 0,
        "z": 35
      },
      "methods": []
    },
    {
      "id": "pos",
      "label": "+",
      "positionMm": {
        "x": 75,
        "y": 0,
        "z": 35
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "supply.bench",
    "params": {
      "maxVoltageV": 30,
      "maxCurrentA": 5,
      "outputResistanceOhm": 0.001
    }
  },
  "controls": [
    {
      "id": "setpointV",
      "label": "Voltage",
      "type": "setpoint",
      "unit": "V",
      "min": 0,
      "max": 30,
      "step": 0.01
    },
    {
      "id": "currentLimitA",
      "label": "Current limit",
      "type": "setpoint",
      "unit": "A",
      "min": 0,
      "max": 5,
      "step": 0.001
    },
    {
      "id": "outputOn",
      "label": "Output",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "linear-bench-supply-class",
      "kind": "real-world",
      "citation": "The single-output 0–30 V, 0–5 A linear laboratory supply, a common bench class with constant-voltage and constant-current regulation and automatic crossover. Typical published figures for the class, paraphrased (not one vendor's): CV load regulation within about 0.01 % + 2 mV from no load to full load, so about 5 mV at 30 V over 5 A, an output resistance of about 1 mΩ; case about 130 mm wide, 160 mm tall and 270 mm deep. The size is the footprint on the bench (130 × 270 mm: width, then front to back) and the height above it (160 mm), the bench axes every bench device uses.",
      "covers": [
        "model.params.maxVoltageV",
        "model.params.maxCurrentA",
        "model.params.outputResistanceOhm",
        "sizeMm"
      ]
    },
    {
      "id": "binding-post-layout",
      "kind": "game-design",
      "citation": "game-design: the − and + binding posts sit on the front panel 35 mm above the bench, 19 mm apart (the 0.75 in spacing of dual banana plugs, a common bench convention); the layout is not modelled on a product.",
      "covers": [
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "supply.railwick-din-24v-5a",
  "version": 1,
  "title": "24 V 5 A DIN-rail power supply",
  "brand": "Railwick",
  "modelName": "RW-24-5",
  "category": "source",
  "sizeMm": {
    "widthMm": 40,
    "heightMm": 125,
    "depthMm": 114
  },
  "terminals": [
    {
      "id": "neg",
      "label": "V−",
      "positionMm": {
        "x": 12,
        "y": 112,
        "z": 114
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 24,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 8,
            "tolerance": 1
          },
          "torqueNm": 0.5,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 12,
            "y": 125,
            "z": 110
          },
          "exitAxis": "+y",
          "clampType": "boxLug",
          "clampDepthMm": 7,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    },
    {
      "id": "pos",
      "label": "V+",
      "positionMm": {
        "x": 28,
        "y": 112,
        "z": 114
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 24,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 8,
            "tolerance": 1
          },
          "torqueNm": 0.5,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 28,
            "y": 125,
            "z": 110
          },
          "exitAxis": "+y",
          "clampType": "boxLug",
          "clampDepthMm": 7,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [
    {
      "type": "din35",
      "widthMm": 40,
      "crossMm": 0
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "supply.dinPsu",
    "params": {
      "ratedVoltageV": 24,
      "ratedCurrentA": 5,
      "currentLimitA": 6,
      "outputResistanceOhm": 0.048,
      "hiccupDetectMs": 100,
      "hiccupOffMs": 1000
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "din-psu-120w-class",
      "kind": "real-world",
      "citation": "The slim 24 V 5 A (120 W) DIN-rail switch-mode supply, a common control-panel class. Typical published figures, paraphrased (not one vendor's): 24 V DC output, 5 A continuous; load regulation within about ±1 % from no load to full load. The output resistance is the worst-case slope of that band (0.24 V over 5 A, 48 mΩ): the band is a tolerance, and real units typically droop less; body about 40 mm wide, 125 mm tall and 114 mm deep from the rail.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedCurrentA",
        "model.params.outputResistanceOhm",
        "sizeMm"
      ]
    },
    {
      "id": "din-psu-overload-protection",
      "kind": "real-world",
      "citation": "Overload protection of the class: a current limit that typically engages between about 105 % and 150 % of the rated current, recovering automatically (hiccup mode) once the fault is removed. 120 % (6 A) is taken, inside that band. Paraphrased from manufacturers' datasheets for the class.",
      "covers": [
        "model.params.currentLimitA"
      ]
    },
    {
      "id": "hiccup-timing",
      "kind": "game-design",
      "citation": "game-design: 100 ms in current limit before the output shuts down, then 1 s off before each restart attempt, a hiccup period of 1.1 s. Datasheets for the class describe hiccup recovery but rarely give its timing; these are chosen to look like it (a short burst, then about a second off).",
      "covers": [
        "model.params.hiccupDetectMs",
        "model.params.hiccupOffMs"
      ]
    },
    {
      "id": "terminal-layout",
      "kind": "game-design",
      "citation": "game-design: the V− and V+ output screw terminals sit on the front face near the top, 16 mm apart; not modelled on a product.",
      "covers": [
        "terminals"
      ]
    },
    {
      "id": "din-psu-terminal-class",
      "kind": "real-world",
      "citation": "The output screw terminals of the 24 V 5 A DIN-rail supply class, from several makers' public datasheets, paraphrased (not one vendor's): copper conductors of about 24 to 12 AWG (some 26 to 14 or 20 to 10), solid, stranded or stranded in a ferrule, a tightening torque of about 0.4 to 0.6 N·m (0.5 N·m is taken) and a strip length of about 7 to 10 mm (8 ± 1 mm is taken). Copper only (not rated for aluminium).",
      "covers": [
        "terminals.*.methods.screw.awgRange",
        "terminals.*.methods.screw.stranding",
        "terminals.*.methods.screw.stripLengthMm",
        "terminals.*.methods.screw.torqueNm",
        "terminals.*.methods.screw.alRated"
      ]
    },
    {
      "id": "din-psu-terminal-counts",
      "kind": "game-design",
      "citation": "game-design: one conductor per terminal is the rating; two fit physically and make a worse termination (D8). Not a published figure.",
      "covers": [
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors"
      ]
    },
    {
      "id": "din-psu-terminal-geometry",
      "kind": "game-design",
      "citation": "game-design: conductors enter the output terminals from the top face (125 mm) above each screw and leave along +y; not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "din-psu-din-mount",
      "kind": "real-world",
      "citation": "The class clips onto a 35 mm DIN rail (IEC 60715) and takes its body width, about 40 mm (the din-psu-120w-class source), along the rail.",
      "covers": [
        "fits.din35"
      ]
    },
    {
      "id": "din-screw-drives",
      "kind": "game-design",
      "citation": "game-design: unverified. DIN-rail power supplies commonly have slotted and Pozidriv combination terminal screws (common practice for IEC-style terminals, not read from one datasheet); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "din-psu-terminal-contact",
      "kind": "game-design",
      "citation": "game-design: the supply's output terminals take the branch-circuit screw class's contact resistance, 0.3 mΩ at the marked torque with copper at 20 °C (NBS Building Science Series 103, 1977, measured 0.2 to 0.5 mΩ on good branch-circuit screw terminals; ADR 0018 §4.1). BSS 103 measured wiring-device terminals, not a power supply's box clamps, so applying it here is a game-design choice.",
      "covers": [
        "terminals.*.methods.screw.contactOhm"
      ]
    },
    {
      "id": "din-psu-terminal-thermal",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §3.3), for F3.6's hot-spot node: the heat path takes the screw class's calibrated 0.026 W/K (no better figure for a supply's terminal); the clamp's heat capacity, 0.5 J/K, is a physics estimate for a smaller box clamp, about 1.3 g of brass and steel × about 380 J/(kg·K).",
      "covers": [
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
      ]
    },
    {
      "id": "din-psu-terminal-clamp",
      "kind": "game-design",
      "citation": "game-design: the supply's screw terminals are box clamps (a rising cage that closes around the conductor), so bare strands are held (ADR 0018 §4.3); the cage grips 7 mm of conductor, inside the 8 ± 1 mm strip. Not modelled on a product.",
      "covers": [
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm"
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
      },
      "methods": []
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 50,
        "y": 20,
        "z": 12
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
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
},
{
  "id": "tb.quennick-pe4",
  "version": 1,
  "title": "Screw-clamp ground (PE) terminal block, 4 mm² class, green-yellow",
  "brand": "Quennick",
  "modelName": "QPE 4",
  "category": "terminalBlock",
  "sizeMm": {
    "widthMm": 6,
    "heightMm": 48,
    "depthMm": 47
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 3,
        "y": 40,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 22,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 9,
            "tolerance": 1
          },
          "torqueNm": 0.6,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 3,
            "y": 48,
            "z": 30
          },
          "exitAxis": "+y",
          "clampType": "boxLug",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 3,
        "y": 8,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 22,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 9,
            "tolerance": 1
          },
          "torqueNm": 0.6,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 3,
            "y": 0,
            "z": 30
          },
          "exitAxis": "-y",
          "clampType": "boxLug",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [
    {
      "type": "din35",
      "widthMm": 6,
      "crossMm": 21
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "terminalBlock.ground",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "tb-4mm2-class",
      "kind": "real-world",
      "citation": "real-world (product class): screw-clamp feed-through DIN-rail terminal blocks of the 4 mm² class are 6.2 mm wide, about 47.7 mm long and 47.5 mm high on a 35 × 7.5 rail (a maker’s published datasheet, read 2026-11-12). Drawn 6 × 48 × 47 mm: the width rounded down to whole mm (so 10 blocks take 60 mm, not 62). Green-yellow, the colour of protective-earth blocks; a real PE block bonds its foot to the rail (P4 grounding, not modelled in P3).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "tb-layout",
      "kind": "game-design",
      "citation": "game-design: two clamps, one at the top (1) and one at the bottom (2), 30 mm off the rail; conductors enter the top and bottom faces. Not taken from a product drawing.",
      "covers": [
        "terminals",
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "tb-din",
      "kind": "game-design",
      "citation": "game-design: clips onto a 35 mm top-hat rail (IEC 60715, cited by number), 6 mm along it, centred on the rail: its origin sits 45 − 24 = 21 mm above the mount origin (DIN 43880’s 90 mm modular-device line, ADR 0015 note 7), so its 48 mm body spans the rail centreline ± 24 mm.",
      "covers": [
        "fits.din35"
      ]
    },
    {
      "id": "tb-screw-class",
      "kind": "real-world",
      "citation": "real-world (product class): the 4 mm² screw feed-through class takes 26–10 AWG copper (of which 22–10 is used here; UL/CSA 30 A, 600 V), solid or stranded, stranded in a ferrule up to 4 mm², with a 9 mm strip and an M3 clamp screw tightened to 0.6–0.8 N·m (a maker’s datasheet, read 2026-11-12). The marked 0.6 N·m is the fictional block’s, at the low end of that range; NFPA 70-2023 Art. 110.14(D) (cited by number) requires the marked value. No UL 486A-B torque table is used.",
      "covers": [
        "terminals.*.methods.screw.awgRange",
        "terminals.*.methods.screw.stranding",
        "terminals.*.methods.screw.torqueNm",
        "terminals.*.methods.screw.alRated"
      ]
    },
    {
      "id": "tb-screw-rules",
      "kind": "game-design",
      "citation": "game-design: the ±1 mm strip tolerance, the 8 mm cage depth (inside the 9 mm strip), the rising-cage (box) clamp type and the 1-rated / 2-fit rule. The real class allows two conductors of equal size only up to 1.5 mm² (about 16 AWG); the game lets two of any size fit and shares the clamp force (a documented abstraction, content caveats).",
      "covers": [
        "terminals.*.methods.screw.stripLengthMm",
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm",
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors"
      ]
    },
    {
      "id": "tb-screw-drives",
      "kind": "game-design",
      "citation": "game-design: unverified. Terminal-block clamp screws commonly take a slotted blade, many with a Pozidriv combination head (common practice, not read from one datasheet); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "tb-screw-contact",
      "kind": "game-design",
      "citation": "game-design: each screw clamp takes the branch-circuit screw class’s contact resistance, 0.3 mΩ at the marked torque with copper at 20 °C (NBS Building Science Series 103, 1977, measured 0.2 to 0.5 mΩ on good branch-circuit screw terminals; ADR 0018 §4.1), and its calibrated 0.026 W/K heat path (§3.3). A terminal-block voltage-drop acceptance (at most 3.2 mV per block, two clamps, at a DC test current of 0.1 × the rated section’s current) gives at most 1.0 mΩ per block at 4 mm² (3.2 A); the model’s two clamps at 0.3 mΩ (0.6 mΩ, plus the ideal bridge) sit inside it. Read on a maker’s terminal-block test page (read 2026-11-12: https://www.phoenixcontact.com/en-ch/quality-tests-for-terminal-blocks/electrical-tests-terminal-blocks), which attributes the test to IEC 60947-7-1, IEC 61984 and UL 1059 (cited by number only; the standards themselves unverified). The cage’s heat capacity, 0.5 J/K, is a physics estimate: about 1.3 g of brass and steel × about 380 J/(kg·K).",
      "covers": [
        "terminals.*.methods.screw.contactOhm",
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tb.quennick-sc25",
  "version": 1,
  "title": "Spring-cage feed-through terminal block, 2.5 mm² class, grey",
  "brand": "Quennick",
  "modelName": "QSC 2.5",
  "category": "terminalBlock",
  "sizeMm": {
    "widthMm": 5,
    "heightMm": 56,
    "depthMm": 36
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 2,
        "y": 48,
        "z": 26
      },
      "methods": [
        {
          "method": "springCage",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 22,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 10,
            "tolerance": 1
          },
          "torqueNm": null,
          "drives": [],
          "alRated": false,
          "entryMm": {
            "x": 2,
            "y": 56,
            "z": 26
          },
          "exitAxis": "+y",
          "clampType": "springCage",
          "clampDepthMm": 9,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.02,
          "hotSpotHeatCapacityJPerK": 0.35,
          "combination": null
        }
      ]
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 2,
        "y": 8,
        "z": 26
      },
      "methods": [
        {
          "method": "springCage",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 22,
            "largest": 12
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 10,
            "tolerance": 1
          },
          "torqueNm": null,
          "drives": [],
          "alRated": false,
          "entryMm": {
            "x": 2,
            "y": 0,
            "z": 26
          },
          "exitAxis": "-y",
          "clampType": "springCage",
          "clampDepthMm": 9,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.02,
          "hotSpotHeatCapacityJPerK": 0.35,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [
    {
      "type": "din35",
      "widthMm": 5,
      "crossMm": 17
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "terminalBlock.feedThrough",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "tb-25mm2-class",
      "kind": "real-world",
      "citation": "real-world (product class): 2.5 mm² spring-cage feed-through blocks are 5.1–5.2 mm wide, about 48.5–59.5 mm long and 36.5–38.5 mm high (makers’ datasheets, read 2026-11-12). Drawn 5 × 56 × 36 mm: the width rounded down to whole mm, the length inside the band, the height 0.5 mm under it (rounded to whole mm).",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "tb-layout",
      "kind": "game-design",
      "citation": "game-design: two spring cages, top (1) and bottom (2), 26 mm off the rail; conductors enter the top and bottom faces. Not taken from a product drawing.",
      "covers": [
        "terminals",
        "terminals.*.methods.springCage.entryMm",
        "terminals.*.methods.springCage.exitAxis"
      ]
    },
    {
      "id": "tb-din",
      "kind": "game-design",
      "citation": "game-design: clips onto a 35 mm top-hat rail (IEC 60715, cited by number), 5 mm along it, centred on the rail: its origin sits 45 − 28 = 17 mm above the mount origin (DIN 43880’s 90 mm modular-device line, ADR 0015 note 7).",
      "covers": [
        "fits.din35"
      ]
    },
    {
      "id": "tb-spring-rating",
      "kind": "real-world",
      "citation": "real-world (product class): the 2.5 mm² spring-cage class takes 26/28–12 AWG copper (of which 22–12 is used here; UL/CSA 20 A, 600 V), solid or stranded, stranded in a ferrule, with an 8–10 mm strip (makers’ datasheets, read 2026-11-12); one conductor per cage. A spring’s force is fixed, so no torque and no drive (the release slot’s blade is not modelled).",
      "covers": [
        "terminals.*.methods.springCage.awgRange",
        "terminals.*.methods.springCage.stranding",
        "terminals.*.methods.springCage.alRated",
        "terminals.*.methods.springCage.ratedConductors",
        "terminals.*.methods.springCage.maxConductors"
      ]
    },
    {
      "id": "tb-spring-rules",
      "kind": "game-design",
      "citation": "game-design: a 10 ± 1 mm strip (inside the class’s 8–10 mm), the spring-cage clamp type and a 9 mm cage depth.",
      "covers": [
        "terminals.*.methods.springCage.stripLengthMm",
        "terminals.*.methods.springCage.clampType",
        "terminals.*.methods.springCage.clampDepthMm"
      ]
    },
    {
      "id": "tb-spring-contact",
      "kind": "game-design",
      "citation": "game-design (ADR 0018 §4.1, §3.3): R₀ 0.3 mΩ, the ADR’s spring-cage example inside NBS BSS 128’s (1980) 1.5 mΩ assembly acceptance limit. A terminal-block voltage-drop acceptance (at most 3.2 mV per block, two clamps, at a DC test current of 0.1 × the rated section’s current) gives at most 1.33 mΩ per block at 2.5 mm² (2.4 A); the model’s two clamps at 0.3 mΩ (0.6 mΩ, plus the ideal bridge) sit inside it. Read on a maker’s terminal-block test page (read 2026-11-12: https://www.phoenixcontact.com/en-ch/quality-tests-for-terminal-blocks/electrical-tests-terminal-blocks), which attributes the test to IEC 60947-7-1, IEC 61984 and UL 1059 (cited by number only; the standards themselves unverified). The heat path, 0.02 W/K, is a game-design scaling below the screw class’s calibrated 0.026 W/K for a smaller clamp (no derivation); the heat capacity, 0.35 J/K, is about 0.8 g of spring steel (about 460–490 J/(kg·K)) and a copper bar (about 385 J/(kg·K)).",
      "covers": [
        "terminals.*.methods.springCage.contactOhm",
        "terminals.*.methods.springCage.heatPathWPerK",
        "terminals.*.methods.springCage.hotSpotHeatCapacityJPerK"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tb.quennick-st4",
  "version": 1,
  "title": "Screw-clamp feed-through terminal block, 4 mm² class, grey",
  "brand": "Quennick",
  "modelName": "QST 4",
  "category": "terminalBlock",
  "sizeMm": {
    "widthMm": 6,
    "heightMm": 48,
    "depthMm": 47
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 3,
        "y": 40,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 22,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 9,
            "tolerance": 1
          },
          "torqueNm": 0.6,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 3,
            "y": 48,
            "z": 30
          },
          "exitAxis": "+y",
          "clampType": "boxLug",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 3,
        "y": 8,
        "z": 30
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 2,
          "awgRange": {
            "smallest": 22,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded",
            "strandedFerrule"
          ],
          "stripLengthMm": {
            "nominal": 9,
            "tolerance": 1
          },
          "torqueNm": 0.6,
          "drives": [
            "slotted",
            "pozidriv"
          ],
          "alRated": false,
          "entryMm": {
            "x": 3,
            "y": 0,
            "z": 30
          },
          "exitAxis": "-y",
          "clampType": "boxLug",
          "clampDepthMm": 8,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 0.5,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [
    {
      "type": "din35",
      "widthMm": 6,
      "crossMm": 21
    }
  ],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "terminalBlock.feedThrough",
    "params": {}
  },
  "controls": [],
  "sources": [
    {
      "id": "tb-4mm2-class",
      "kind": "real-world",
      "citation": "real-world (product class): screw-clamp feed-through DIN-rail terminal blocks of the 4 mm² class are 6.2 mm wide, about 47.7 mm long and 47.5 mm high on a 35 × 7.5 rail (a maker’s published datasheet, read 2026-11-12). Drawn 6 × 48 × 47 mm: the width rounded down to whole mm (so 10 blocks take 60 mm, not 62). Grey, the usual colour for line conductors.",
      "covers": [
        "sizeMm"
      ]
    },
    {
      "id": "tb-layout",
      "kind": "game-design",
      "citation": "game-design: two clamps, one at the top (1) and one at the bottom (2), 30 mm off the rail; conductors enter the top and bottom faces. Not taken from a product drawing.",
      "covers": [
        "terminals",
        "terminals.*.methods.screw.entryMm",
        "terminals.*.methods.screw.exitAxis"
      ]
    },
    {
      "id": "tb-din",
      "kind": "game-design",
      "citation": "game-design: clips onto a 35 mm top-hat rail (IEC 60715, cited by number), 6 mm along it, centred on the rail: its origin sits 45 − 24 = 21 mm above the mount origin (DIN 43880’s 90 mm modular-device line, ADR 0015 note 7), so its 48 mm body spans the rail centreline ± 24 mm.",
      "covers": [
        "fits.din35"
      ]
    },
    {
      "id": "tb-screw-class",
      "kind": "real-world",
      "citation": "real-world (product class): the 4 mm² screw feed-through class takes 26–10 AWG copper (of which 22–10 is used here; UL/CSA 30 A, 600 V), solid or stranded, stranded in a ferrule up to 4 mm², with a 9 mm strip and an M3 clamp screw tightened to 0.6–0.8 N·m (a maker’s datasheet, read 2026-11-12). The marked 0.6 N·m is the fictional block’s, at the low end of that range; NFPA 70-2023 Art. 110.14(D) (cited by number) requires the marked value. No UL 486A-B torque table is used.",
      "covers": [
        "terminals.*.methods.screw.awgRange",
        "terminals.*.methods.screw.stranding",
        "terminals.*.methods.screw.torqueNm",
        "terminals.*.methods.screw.alRated"
      ]
    },
    {
      "id": "tb-screw-rules",
      "kind": "game-design",
      "citation": "game-design: the ±1 mm strip tolerance, the 8 mm cage depth (inside the 9 mm strip), the rising-cage (box) clamp type and the 1-rated / 2-fit rule. The real class allows two conductors of equal size only up to 1.5 mm² (about 16 AWG); the game lets two of any size fit and shares the clamp force (a documented abstraction, content caveats).",
      "covers": [
        "terminals.*.methods.screw.stripLengthMm",
        "terminals.*.methods.screw.clampType",
        "terminals.*.methods.screw.clampDepthMm",
        "terminals.*.methods.screw.ratedConductors",
        "terminals.*.methods.screw.maxConductors"
      ]
    },
    {
      "id": "tb-screw-drives",
      "kind": "game-design",
      "citation": "game-design: unverified. Terminal-block clamp screws commonly take a slotted blade, many with a Pozidriv combination head (common practice, not read from one datasheet); the drive type is a name and its size is not modelled.",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    },
    {
      "id": "tb-screw-contact",
      "kind": "game-design",
      "citation": "game-design: each screw clamp takes the branch-circuit screw class’s contact resistance, 0.3 mΩ at the marked torque with copper at 20 °C (NBS Building Science Series 103, 1977, measured 0.2 to 0.5 mΩ on good branch-circuit screw terminals; ADR 0018 §4.1), and its calibrated 0.026 W/K heat path (§3.3). A terminal-block voltage-drop acceptance (at most 3.2 mV per block, two clamps, at a DC test current of 0.1 × the rated section’s current) gives at most 1.0 mΩ per block at 4 mm² (3.2 A); the model’s two clamps at 0.3 mΩ (0.6 mΩ, plus the ideal bridge) sit inside it. Read on a maker’s terminal-block test page (read 2026-11-12: https://www.phoenixcontact.com/en-ch/quality-tests-for-terminal-blocks/electrical-tests-terminal-blocks), which attributes the test to IEC 60947-7-1, IEC 61984 and UL 1059 (cited by number only; the standards themselves unverified). The cage’s heat capacity, 0.5 J/K, is a physics estimate: about 1.3 g of brass and steel × about 380 J/(kg·K).",
      "covers": [
        "terminals.*.methods.screw.contactOhm",
        "terminals.*.methods.screw.heatPathWPerK",
        "terminals.*.methods.screw.hotSpotHeatCapacityJPerK"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-208y120-150kva",
  "version": 1,
  "title": "208Y/120 V three-phase utility service, 150 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-3W150",
  "category": "source",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "l3",
      "label": "L3",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 350,
        "y": 250,
        "z": 200
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "utility.threePhase",
    "params": {
      "ratedKva": 150,
      "percentImpedance": 4,
      "xOverR": 3,
      "lineToNeutralV": 120
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "commercial-transformer-class",
      "kind": "real-world",
      "citation": "A three-phase pad-mounted distribution transformer for a small commercial building: 150 kVA, with an impedance of about 2–5 % and an X/R ratio of about 2–4, typical of published manufacturers' data for the size (paraphrased, not one vendor's). 4 % and an X/R of 3 are taken: per phase 0.04 × (√3 × 120)² / 150 000 = 11.5 mΩ, about 10.4 kA of bolted three-phase fault current, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "wye-208-nominal",
      "kind": "real-world",
      "citation": "120 V from each phase to the neutral of the 208Y/120 V three-phase four-wire nominal system of ANSI C84.1-2020 (the region profile's commercial system); 208 V is the rounded name of 120 × √3 = 207.85 V.",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. Three-phase service is headless in P2 (gameplay is P6), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-480y277-1000kva",
  "version": 1,
  "title": "480Y/277 V three-phase utility service, 1000 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-3W1000",
  "category": "source",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "l3",
      "label": "L3",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      },
      "methods": []
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 350,
        "y": 250,
        "z": 200
      },
      "methods": []
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "utility.threePhase",
    "params": {
      "ratedKva": 1000,
      "percentImpedance": 5.75,
      "xOverR": 6,
      "lineToNeutralV": 277
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "industrial-transformer-class",
      "kind": "real-world",
      "citation": "A three-phase liquid-filled substation or pad-mounted transformer for an industrial plant: 1000 kVA, with an impedance of 5.75 %, a long-standing typical value for the size, and an X/R ratio of about 5–7, from published manufacturers' data and short-circuit study guides (paraphrased, not one vendor's). An X/R of 6 is taken: per phase 0.0575 × (√3 × 277)² / 1 000 000 = 13.2 mΩ, about 20.9 kA of bolted three-phase fault current, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "wye-480-nominal",
      "kind": "real-world",
      "citation": "277 V from each phase to the neutral of the 480Y/277 V three-phase four-wire nominal system of ANSI C84.1-2020 (the region profile's industrial system); 480 V is the rounded name of 277 × √3 = 479.78 V.",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. Three-phase service is headless in P2 (gameplay is P6), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-split-phase-25kva",
  "version": 1,
  "title": "120/240 V split-phase utility service, 25 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-SP25",
  "category": "source",
  "sizeMm": {
    "widthMm": 300,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": 4,
          "drives": [
            "slotted",
            "square"
          ],
          "alRated": true,
          "entryMm": {
            "x": 50,
            "y": 250,
            "z": 200
          },
          "exitAxis": "+z",
          "clampType": "pressurePlate",
          "clampDepthMm": 10,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": 4,
          "drives": [
            "slotted",
            "square"
          ],
          "alRated": true,
          "entryMm": {
            "x": 250,
            "y": 250,
            "z": 200
          },
          "exitAxis": "+z",
          "clampType": "pressurePlate",
          "clampDepthMm": 10,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      },
      "methods": [
        {
          "method": "screw",
          "ratedConductors": 1,
          "maxConductors": 1,
          "awgRange": {
            "smallest": 14,
            "largest": 10
          },
          "stranding": [
            "solid",
            "stranded"
          ],
          "stripLengthMm": {
            "nominal": 13,
            "tolerance": 2
          },
          "torqueNm": 4,
          "drives": [
            "slotted",
            "square"
          ],
          "alRated": true,
          "entryMm": {
            "x": 150,
            "y": 250,
            "z": 200
          },
          "exitAxis": "+z",
          "clampType": "pressurePlate",
          "clampDepthMm": 10,
          "contactOhm": 0.0003,
          "heatPathWPerK": 0.026,
          "hotSpotHeatCapacityJPerK": 1.1,
          "combination": null
        }
      ]
    }
  ],
  "mounts": [],
  "enclosure": null,
  "conductor": null,
  "model": {
    "kind": "utility.splitPhase",
    "params": {
      "ratedKva": 25,
      "percentImpedance": 2,
      "xOverR": 2,
      "lineToNeutralV": 120
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "pole-transformer-class",
      "kind": "real-world",
      "citation": "A single-phase overhead (pole-mounted) distribution transformer serving a house: 25 kVA is a common size for one to a few homes, with an impedance of about 1.5–3 % and an X/R ratio of about 1–3, typical of published manufacturers' data and utility service guides for small single-phase units (paraphrased, not one vendor's). 2 % and an X/R of 2 are taken: a full-winding impedance of 0.02 × 240² / 25 000 = 46.1 mΩ, about 5.2 kA of bolted fault current across L1–L2, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "split-phase-nominal",
      "kind": "real-world",
      "citation": "120 V from each line to the neutral (the secondary's centre tap), the 120/240 V single-phase three-wire nominal system of ANSI C84.1-2020 (the region profile's split-phase system).",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. The service is headless in P2 (no service entrance or meter base until P4), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    },
    {
      "id": "stand-in-terminals",
      "kind": "game-design",
      "citation": "game-design: in P3 this service is the stand-in supply of the demo circuit (D12), standing in for P4's load centre, so each terminal takes one branch-circuit conductor: 14 to 10 AWG copper or aluminium, solid or stranded, a 13 ± 2 mm strip. The 4.0 N·m torque on all three is the breaker load terminal's value (breaker.saltmere-1p-15a), reused for simplicity; a real neutral bar is commonly marked lower (about 2.3 N·m, 20 lb·in, for 14 to 10 AWG), which P4's neutral bar will take. Conductors enter at the terminals and leave along +z. Not a transformer secondary's real terminals; P4 replaces it. Their contact and clamp values copy the breaker's screw class (ADR 0018 §8): a pressure plate gripping 10 mm, R₀ 0.3 mΩ (NBS BSS 103's good-connection class), a 0.026 W/K heat path and a 1.1 J/K clamp, all game-design here, like the torque.",
      "covers": [
        "terminals.*.methods.screw"
      ]
    },
    {
      "id": "service-screw-drives",
      "kind": "game-design",
      "citation": "game-design: the stand-in service terminals take the same slotted and square combination head as the branch breaker (the D12 stand-in for P4's load centre).",
      "covers": [
        "terminals.*.methods.screw.drives"
      ]
    }
  ],
  "extensions": {}
}
];
