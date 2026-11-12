/*
 * GENERATED from content/tools/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_TOOL_DOCUMENTS: readonly unknown[] = [
{
  "id": "tool.calderyn-ts-03",
  "version": 1,
  "title": "Torque screwdriver, 0.3–1.2 N·m",
  "brand": "Calderyn",
  "modelName": "TS-03",
  "kind": "torqueDriver",
  "capabilities": [
    {
      "step": "drive",
      "maxAwg": null
    },
    {
      "step": "torque",
      "maxAwg": null
    }
  ],
  "holes": [],
  "dies": [],
  "torque": {
    "minNm": 0.3,
    "maxNm": 1.2,
    "accuracyFraction": 0.06
  },
  "boreDiameterMm": null,
  "drives": [
    "slotted",
    "phillips",
    "pozidriv",
    "square"
  ],
  "sources": [
    {
      "id": "torque-driver-capabilities",
      "kind": "game-design",
      "citation": "game-design: an adjustable torque screwdriver drives a screw and slips at its setting, so it has drive and torque, with no conductor size limit. The torque a terminal needs comes from the device's own marking (NFPA 70-2023 Art. 110.14(D), cited by number), never from a torque table.",
      "covers": [
        "capabilities"
      ]
    },
    {
      "id": "low-range-torque-driver-class",
      "kind": "real-world",
      "citation": "ISO 6789-1:2017 Type II Class D (cited by number), plus or minus 6 % from the lowest marked value to the maximum. Low-range adjustable torque screwdrivers for terminal screws are made in about 0.3-1.2 N·m, and one maker's datasheet reads 0.1-1.2 N·m at plus or minus 6 %, tested to ISO 6789-2:2017 (typical published figures, paraphrased, not one vendor's).",
      "covers": [
        "torque"
      ]
    },
    {
      "id": "torque-driver-bits",
      "kind": "game-design",
      "citation": "game-design: its 1/4 in hex bit holder (hex-shank bits, ISO 1173 cited by number) takes slotted, cross-recess (Phillips and Pozidriv) and square bits, all assumed in the kit; bit sizes are names.",
      "covers": [
        "drives"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.calderyn-ts-15",
  "version": 1,
  "title": "Torque screwdriver, 1–5 N·m",
  "brand": "Calderyn",
  "modelName": "TS-15",
  "kind": "torqueDriver",
  "capabilities": [
    {
      "step": "drive",
      "maxAwg": null
    },
    {
      "step": "torque",
      "maxAwg": null
    }
  ],
  "holes": [],
  "dies": [],
  "torque": {
    "minNm": 1,
    "maxNm": 5,
    "accuracyFraction": 0.06
  },
  "boreDiameterMm": null,
  "drives": [
    "slotted",
    "phillips",
    "pozidriv",
    "square"
  ],
  "sources": [
    {
      "id": "torque-driver-capabilities",
      "kind": "game-design",
      "citation": "game-design: an adjustable torque screwdriver drives a screw and slips at its setting, so it has drive and torque, with no conductor size limit. The torque a terminal needs comes from the device's own marking (NFPA 70-2023 Art. 110.14(D), cited by number), never from a torque table.",
      "covers": [
        "capabilities"
      ]
    },
    {
      "id": "torque-driver-class",
      "kind": "real-world",
      "citation": "ISO 6789-1:2017 (cited by number) classes an adjustable, graduated torque screwdriver as a setting tool, Type II Class D, with a maximum permissible deviation of plus or minus 6 % over its specified range, from its lowest marked value to its maximum. Several makers' adjustable torque screwdrivers of the 1-5 N·m class state plus or minus 6 % to ISO 6789 (typical published figures, paraphrased, not one vendor's).",
      "covers": [
        "torque"
      ]
    },
    {
      "id": "torque-driver-bits",
      "kind": "game-design",
      "citation": "game-design: its 1/4 in hex bit holder (hex-shank bits, ISO 1173 cited by number) takes slotted, cross-recess (Phillips and Pozidriv) and square bits, all assumed in the kit; bit sizes are names.",
      "covers": [
        "drives"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.penmarrow-lp-12",
  "version": 1,
  "title": "Label printer, 12 mm tape",
  "brand": "Penmarrow",
  "modelName": "LP-12",
  "kind": "labelMaker",
  "capabilities": [
    {
      "step": "label",
      "maxAwg": null
    }
  ],
  "holes": [],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [],
  "sources": [
    {
      "id": "label-printer",
      "kind": "game-design",
      "citation": "game-design: a handheld label printer for wire, cable and device labels (wire markers and panel labels are common practice). It prints the label text a command carries and nothing else; the tape width is a name, not a modelled value.",
      "covers": [
        "capabilities"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-cr-2210",
  "version": 1,
  "title": "Crimper for insulated terminals, 22–10 AWG",
  "brand": "Veltmark",
  "modelName": "CR-2210",
  "kind": "crimper",
  "capabilities": [
    {
      "step": "crimp",
      "maxAwg": 10
    }
  ],
  "holes": [],
  "dies": [
    {
      "id": "red",
      "label": "Red 22–18",
      "awgRange": {
        "smallest": 22,
        "largest": 18
      }
    },
    {
      "id": "blue",
      "label": "Blue 16–14",
      "awgRange": {
        "smallest": 16,
        "largest": 14
      }
    },
    {
      "id": "yellow",
      "label": "Yellow 12–10",
      "awgRange": {
        "smallest": 12,
        "largest": 10
      }
    }
  ],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [],
  "sources": [
    {
      "id": "insulated-terminal-colour-code",
      "kind": "real-world",
      "citation": "Pre-insulated ring, fork and butt terminals are colour-coded across makers (typical published figures, paraphrased, not one vendor's): red for 22-18 AWG (some makers mark red 22-16), blue for 16-14 AWG and yellow for 12-10 AWG, and ratcheting crimpers of this class carry matching coloured die nests. The die ids are the colours (stable save format); crimp connectors are listed to UL 486A-B (cited by number only).",
      "covers": [
        "dies"
      ]
    },
    {
      "id": "crimper-capability",
      "kind": "game-design",
      "citation": "game-design: the crimp capability reaches the largest die, 10 AWG.",
      "covers": [
        "capabilities"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-dc-8",
  "version": 1,
  "title": "High-leverage diagonal cutters, 8 in",
  "brand": "Veltmark",
  "modelName": "DC-8",
  "kind": "cutter",
  "capabilities": [
    {
      "step": "cut",
      "maxAwg": 8
    }
  ],
  "holes": [],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [],
  "sources": [
    {
      "id": "diagonal-cutter-capacity",
      "kind": "game-design",
      "citation": "game-design: unverified product-class figure. Diagonal cutting nippers are specified in ISO 5749 (cited by number); makers of 180-200 mm (7-8 in) high-leverage models state cutting capacities for medium-hard, hard and piano wire (a few millimetres, smallest for piano wire), and soft copper cuts more easily than any of them. The cut is capped at 8 AWG solid copper, 3.26 mm across (the AWG formula, NBS Handbook 100 section 2), a figure chosen for play inside that class.",
      "covers": [
        "capabilities"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-nd-516",
  "version": 1,
  "title": "Nut driver, 5/16 in",
  "brand": "Veltmark",
  "modelName": "ND-516",
  "kind": "nutDriver",
  "capabilities": [
    {
      "step": "drive",
      "maxAwg": null
    }
  ],
  "holes": [],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [
    "hex"
  ],
  "sources": [
    {
      "id": "nut-driver",
      "kind": "game-design",
      "citation": "game-design: a nut driver drives screws with no torque setting, like a plain screwdriver, and with no conductor size limit.",
      "covers": [
        "capabilities"
      ]
    },
    {
      "id": "nut-driver-hex",
      "kind": "real-world",
      "citation": "A 5/16 in nut driver fits the head of a #10 hex-washer-head screw, common on boxes, panels and ground screws (hex-washer-head dimensions per ASME B18.6.3, cited by number, unverified). Only the hex drive is modelled; the size is a name.",
      "covers": [
        "drives"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-sd-2",
  "version": 1,
  "title": "Screwdriver, #2 Phillips / 1/4 in slotted",
  "brand": "Veltmark",
  "modelName": "SD-2",
  "kind": "screwdriver",
  "capabilities": [
    {
      "step": "drive",
      "maxAwg": null
    }
  ],
  "holes": [],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [
    "slotted",
    "phillips"
  ],
  "sources": [
    {
      "id": "plain-screwdriver",
      "kind": "game-design",
      "citation": "game-design: a plain screwdriver drives a terminal screw but has no torque setting, so the torque it applies is a seeded spread around the terminal's marked value (plan D8, ADR 0015), and it opens knockouts, pryouts and box clamps (the ENTRY_TYPES registry). No size limit: driving a screw doesn't depend on the conductor.",
      "covers": [
        "capabilities"
      ]
    },
    {
      "id": "screwdriver-tips",
      "kind": "real-world",
      "citation": "A two-tip electrician's screwdriver with a slotted blade (ISO 2380, cited by number; a 1/4 in blade is about 1.2 x 6.5 mm) and a #2 cross-recess tip (ISO 8764, cited by number). Only the tip forms are modelled; their sizes are names.",
      "covers": [
        "drives"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-ws-1018",
  "version": 1,
  "title": "Wire strippers, 10–18 AWG solid / 12–20 AWG stranded",
  "brand": "Veltmark",
  "modelName": "WS-1018",
  "kind": "stripper",
  "capabilities": [
    {
      "step": "strip",
      "maxAwg": 10
    },
    {
      "step": "cut",
      "maxAwg": 10
    }
  ],
  "holes": [
    {
      "id": "sol10",
      "awg": 10,
      "stranding": "solid"
    },
    {
      "id": "sol12",
      "awg": 12,
      "stranding": "solid"
    },
    {
      "id": "sol14",
      "awg": 14,
      "stranding": "solid"
    },
    {
      "id": "sol16",
      "awg": 16,
      "stranding": "solid"
    },
    {
      "id": "sol18",
      "awg": 18,
      "stranding": "solid"
    },
    {
      "id": "str12",
      "awg": 12,
      "stranding": "stranded"
    },
    {
      "id": "str14",
      "awg": 14,
      "stranding": "stranded"
    },
    {
      "id": "str16",
      "awg": 16,
      "stranding": "stranded"
    },
    {
      "id": "str18",
      "awg": 18,
      "stranding": "stranded"
    },
    {
      "id": "str20",
      "awg": 20,
      "stranding": "stranded"
    }
  ],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [],
  "sources": [
    {
      "id": "stripper-hole-pattern",
      "kind": "real-world",
      "citation": "Electricians' wire strippers marked 10-18 AWG solid on one side of the jaws and 12-20 AWG stranded on the other are a common class made by several makers (typical published markings, paraphrased, not one vendor's). Each physical hole carries a solid size and the stranded size of the next even size, two AWG numbers smaller: a 7-strand concentric conductor of equal area is 3/sqrt(7), about 1.134, times the solid diameter, so stranded 12 AWG is about 2.33 mm across, between solid 11 AWG (2.30 mm) and 10 AWG (2.59 mm), and fits the solid-10 hole (diameters from the AWG formula, NBS Handbook 100 section 2). Modelled as one hole per marking (ten ids, stable save format).",
      "covers": [
        "holes"
      ]
    },
    {
      "id": "stripper-jaws",
      "kind": "game-design",
      "citation": "game-design: strippers of this class have cutting edges between the pivot and the holes, modelled as a cut capability up to 10 AWG, the largest hole; the strip capability reaches the same largest marked hole.",
      "covers": [
        "capabilities"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "tool.veltmark-ws-nm12",
  "version": 1,
  "title": "NM cable stripper, 12–14 AWG solid / 14–16 AWG stranded",
  "brand": "Veltmark",
  "modelName": "WS-NM12",
  "kind": "stripper",
  "capabilities": [
    {
      "step": "strip",
      "maxAwg": 12
    },
    {
      "step": "stripJacket",
      "maxAwg": 12
    },
    {
      "step": "cut",
      "maxAwg": 12
    }
  ],
  "holes": [
    {
      "id": "sol12",
      "awg": 12,
      "stranding": "solid"
    },
    {
      "id": "sol14",
      "awg": 14,
      "stranding": "solid"
    },
    {
      "id": "str14",
      "awg": 14,
      "stranding": "stranded"
    },
    {
      "id": "str16",
      "awg": 16,
      "stranding": "stranded"
    }
  ],
  "dies": [],
  "torque": null,
  "boreDiameterMm": null,
  "drives": [],
  "sources": [
    {
      "id": "nm-stripper-class",
      "kind": "real-world",
      "citation": "Dual-slot strippers for non-metallic sheathed cable are a common class made by several makers (typical published figures, paraphrased, not one vendor's): slots that split the outer jacket of 12/2 and 14/2 cable, conductor holes for 12-14 AWG solid and 14-16 AWG stranded (each stranded marking two AWG numbers smaller than the solid one in the same hole, as on general strippers), and a cutting edge. Hole ids are stable save format.",
      "covers": [
        "holes",
        "capabilities"
      ]
    }
  ],
  "extensions": {}
}
];
