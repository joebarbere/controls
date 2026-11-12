/*
 * GENERATED from content/tools/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_TOOL_DOCUMENTS: readonly unknown[] = [
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
      "kind": "game-design",
      "citation": "game-design: unverified product-class figures, for electrical-realism-reviewer to check. ISO 6789-1 (cited by number) classes adjustable torque screwdrivers as setting tools, and makers commonly state a permissible deviation of plus or minus 6 % of the setting, verified from 20 % to 100 % of the maximum. A 1-5 N·m range keeps the minimum at 20 % of the maximum and reaches the 4 N·m this game's branch-breaker and stand-in service screws are marked with; the 0.5 N·m DIN supply terminals are below it (a plain screwdriver lands them until a low-range driver is added).",
      "covers": [
        "torque"
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
  "sources": [
    {
      "id": "insulated-terminal-colour-code",
      "kind": "game-design",
      "citation": "game-design: unverified industry convention, for electrical-realism-reviewer to check. Pre-insulated ring, fork and butt terminals are colour-coded across makers, red for 22-18 AWG, blue for 16-14 AWG and yellow for 12-10 AWG, and ratcheting crimpers for them carry matching coloured die nests. The die ids are the colours (stable save format); crimp connectors are listed to UL 486A-B (cited by number only).",
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
  "title": "Diagonal cutters, 8 in",
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
  "sources": [
    {
      "id": "diagonal-cutter-capacity",
      "kind": "game-design",
      "citation": "game-design: unverified product-class figure. Diagonal cutting nippers are specified in ISO 5749 (cited by number); makers of 180-200 mm (7-8 in) high-leverage models commonly quote a soft-wire cutting capacity of roughly 3 to 4 mm. Solid 8 AWG copper is 3.26 mm across (the AWG formula, NBS Handbook 100 section 2) and 6 AWG is 4.11 mm, so cut is capped at 8 AWG, rounded down for play.",
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
  "sources": [
    {
      "id": "nut-driver",
      "kind": "game-design",
      "citation": "game-design: a hex nut driver for hex-washer-head screws (box and panel hardware, ground screws). It drives screws with no torque setting, like a plain screwdriver; the 5/16 in size is a name for the player, not a modelled value.",
      "covers": [
        "capabilities"
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
  "sources": [
    {
      "id": "plain-screwdriver",
      "kind": "game-design",
      "citation": "game-design: a plain two-tip screwdriver of the kind every electrician carries (tip forms per ISO 8764 and ISO 2380, cited by number). It drives a terminal screw but has no torque setting, so the torque it applies is a seeded spread around the terminal's marked value (plan D8, ADR 0015), and it opens knockouts, pryouts and box clamps (the ENTRY_TYPES registry). No size limit: driving a screw doesn't depend on the conductor.",
      "covers": [
        "capabilities"
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
    },
    {
      "step": "stripJacket",
      "maxAwg": 12
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
  "sources": [
    {
      "id": "stripper-hole-pattern",
      "kind": "game-design",
      "citation": "game-design: unverified product-class pattern, for electrical-realism-reviewer to check against makers' catalogues. US electricians' wire strippers are commonly marked 10-18 AWG solid on one side of the jaws and 12-20 AWG stranded on the other: each physical hole carries a solid size and the stranded size one step smaller, because a stranded conductor is wider than a solid one of the same AWG. Modelled as one hole per marking (ten ids, stable save format), so a conductor stripped in a hole marked for another size or stranding nicks (plan D8).",
      "covers": [
        "holes"
      ]
    },
    {
      "id": "stripper-jaws-and-nm-slot",
      "kind": "game-design",
      "citation": "game-design: unverified product-class features. Strippers of this class have cutting edges between the pivot and the holes (a cut capability up to 10 AWG, the largest hole), and some models add a slot that splits the outer jacket of 14/2 and 12/2 non-metallic sheathed cable (stripJacket up to 12 AWG conductors). The strip capability reaches the largest marked hole, 10 AWG.",
      "covers": [
        "capabilities"
      ]
    }
  ],
  "extensions": {}
}
];
