/*
 * GENERATED from content/cables/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_CABLE_DOCUMENTS: readonly unknown[] = [
{
  "id": "cable.sorrelby-nmb-10-2",
  "version": 1,
  "title": "NM-B 10/2 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-10-2G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-10-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-10-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-bare-10-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "orange",
    "thicknessMm": 0.762,
    "widthMm": 12.45,
    "heightMm": 5.72
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 10/2 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 2 insulated 10 AWG copper conductors (solid) laid parallel with a bare 10 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black for the ungrounded conductor is convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 10 AWG, so orange. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 10/2, flat, about 0.225 × 0.490 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-10-3",
  "version": 1,
  "title": "NM-B 10/3 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-10-3G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-10-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-10-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "red",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-nm-10-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 3,
      "conductor": {
        "id": "conductor.sorrelby-bare-10-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "orange",
    "thicknessMm": 0.762,
    "widthMm": 16.51,
    "heightMm": 6.35
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 10/3 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 3 insulated 10 AWG copper conductors (solid) laid parallel with a bare 10 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black and red for the ungrounded conductors are convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 10 AWG, so orange. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 10/3, flat, about 0.250 × 0.650 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-12-2",
  "version": 1,
  "title": "NM-B 12/2 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-12-2G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-12-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-12-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-bare-12-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "yellow",
    "thicknessMm": 0.762,
    "widthMm": 10.16,
    "heightMm": 5.08
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 12/2 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 2 insulated 12 AWG copper conductors (solid) laid parallel with a bare 12 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black for the ungrounded conductor is convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 12 AWG, so yellow. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 12/2, flat, about 0.200 × 0.400 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-12-3",
  "version": 1,
  "title": "NM-B 12/3 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-12-3G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-12-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-12-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "red",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-nm-12-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 3,
      "conductor": {
        "id": "conductor.sorrelby-bare-12-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "yellow",
    "thicknessMm": 0.762,
    "widthMm": 13.21,
    "heightMm": 5.08
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 12/3 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 3 insulated 12 AWG copper conductors (solid) laid parallel with a bare 12 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black and red for the ungrounded conductors are convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 12 AWG, so yellow. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 12/3, flat, about 0.200 × 0.520 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-14-2",
  "version": 1,
  "title": "NM-B 14/2 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-14-2G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-14-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-14-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-bare-14-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "white",
    "thicknessMm": 0.762,
    "widthMm": 9.4,
    "heightMm": 4.7
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 14/2 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 2 insulated 14 AWG copper conductors (solid) laid parallel with a bare 14 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black for the ungrounded conductor is convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 14 AWG, so white. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 14/2, flat, about 0.185 × 0.370 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-14-3",
  "version": 1,
  "title": "NM-B 14/3 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-14-3G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-14-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-14-solid",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "red",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-nm-14-solid",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 3,
      "conductor": {
        "id": "conductor.sorrelby-bare-14-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "white",
    "thicknessMm": 0.762,
    "widthMm": 11.43,
    "heightMm": 4.7
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 14/3 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 3 insulated 14 AWG copper conductors (solid) laid parallel with a bare 14 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black and red for the ungrounded conductors are convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 14 AWG, so white. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 14/3, flat, about 0.185 × 0.450 in, converted at 25.4 mm/in and rounded to 0.01 mm (height the minor axis, width the major). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-6-3",
  "version": 1,
  "title": "NM-B 6/3 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-6-3G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-6-stranded",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-6-stranded",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "red",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-nm-6-stranded",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 3,
      "conductor": {
        "id": "conductor.sorrelby-bare-10-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "black",
    "thicknessMm": 0.762,
    "widthMm": 14.61,
    "heightMm": 14.61
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 6/3 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 3 insulated 6 AWG copper conductors (7-strand) twisted together with a bare 10 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black and red for the ungrounded conductors are convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 6 AWG, so black. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 6/3, round, about 0.575 in across, converted at 25.4 mm/in and rounded to 0.01 mm (width and height both the diameter). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "cable.sorrelby-nmb-8-3",
  "version": 1,
  "title": "NM-B 8/3 with ground, copper, 600 V",
  "brand": "Sorrelby",
  "modelName": "SB-NMB-8-3G",
  "conductors": [
    {
      "index": 0,
      "conductor": {
        "id": "conductor.sorrelby-nm-8-stranded",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "black",
        "stripe": null
      }
    },
    {
      "index": 1,
      "conductor": {
        "id": "conductor.sorrelby-nm-8-stranded",
        "version": 1
      },
      "role": "ungrounded",
      "insulated": true,
      "colour": {
        "base": "red",
        "stripe": null
      }
    },
    {
      "index": 2,
      "conductor": {
        "id": "conductor.sorrelby-nm-8-stranded",
        "version": 1
      },
      "role": "grounded",
      "insulated": true,
      "colour": {
        "base": "white",
        "stripe": null
      }
    },
    {
      "index": 3,
      "conductor": {
        "id": "conductor.sorrelby-bare-10-solid",
        "version": 1
      },
      "role": "egc",
      "insulated": false,
      "colour": {
        "base": "bare",
        "stripe": null
      }
    }
  ],
  "jacket": {
    "material": {
      "table": "insulation",
      "version": 1,
      "key": "nmbJacket"
    },
    "colour": "black",
    "thicknessMm": 0.762,
    "widthMm": 13.46,
    "heightMm": 13.46
  },
  "sources": [
    {
      "id": "nmb-construction",
      "kind": "real-world",
      "citation": "A US maker's public NM-B product sheet (rev. 03/2019, read; it carries no ampacity column), paraphrased: NM-B 8/3 with ground is listed to UL 719, its insulated conductors to UL 83 (both by number); 3 insulated 8 AWG copper conductors (7-strand) twisted together with a bare 10 AWG copper grounding conductor wrapped in paper, the assembly wrapped in a paper separator under a PVC jacket. The conductor entries are pinned (the sorrelby-nm and sorrelby-bare entries). Roles and colours: white is the grounded conductor (NFPA 70-2023 Art. 200.6), the bare conductor is the EGC (Art. 250.119), both by number; black and red for the ungrounded conductors are convention, not code. The order (ungrounded, grounded, EGC) is save format. NM-B's 60 °C ampacity limit (Art. 334.80, by number) is a P4 rule; no ampacity is stored.",
      "covers": [
        "conductors"
      ]
    },
    {
      "id": "nmb-jacket-material",
      "kind": "real-world",
      "citation": "The jacket is PVC applied over the whole assembly (the same sheet): the pinned insulation row nmbJacket, whose 90 °C is the conductors' rating; NM cable is for dry locations only (NFPA 70-2023 Art. 334.12, by number).",
      "covers": [
        "jacket.material"
      ]
    },
    {
      "id": "nmb-jacket-colour",
      "kind": "real-world",
      "citation": "Jacket colour by conductor size, a convention shared across makers' NM-B lines and shown on the same sheet: white for 14 AWG, yellow for 12 AWG, orange for 10 AWG, black for 8 and 6 AWG; this cable is 8 AWG, so black. Some makers colour three-conductor cable differently; this catalogue uses the size colour for both (a game-design choice between real schemes).",
      "covers": [
        "jacket.colour"
      ]
    },
    {
      "id": "nmb-dimensions",
      "kind": "real-world",
      "citation": "The same sheet's approximate cable dimension for 8/3, round, about 0.530 in across, converted at 25.4 mm/in and rounded to 0.01 mm (width and height both the diameter). It includes the paper wraps the model doesn't carry. Paraphrased per entry; no table copied.",
      "covers": [
        "jacket.widthMm",
        "jacket.heightMm"
      ]
    },
    {
      "id": "nmb-jacket-thickness",
      "kind": "game-design",
      "citation": "game-design: a 0.762 mm (30 mil) PVC jacket wall. Makers' NM-B sheets commonly state 25 to 30 mil, but the sheets seen that state it also carry ampacity columns (NEC table reprints), so none is cited; the sheet read gives none.",
      "covers": [
        "jacket.thicknessMm"
      ]
    }
  ],
  "extensions": {}
}
];
