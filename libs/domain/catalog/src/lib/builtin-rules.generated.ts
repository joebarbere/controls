/*
 * GENERATED from content/rules/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_RULE_DOCUMENTS: readonly unknown[] = [
{
  "ruleSet": "nec",
  "version": 1,
  "title": "US residential inspection (NEC)",
  "edition": "NFPA 70-2023",
  "rules": [
    {
      "id": "smallConductorOcpd",
      "article": "240.4(D)",
      "title": "Small conductor on too large a breaker",
      "paraphrase": "Small conductors (the smallest copper and aluminium sizes) may not be protected by an overcurrent device larger than the limit the code sets for their size and material, whatever their ampacity, unless another rule permits it. The inspector reads each conductor entry's own published rating.",
      "severity": "violation",
      "check": null
    },
    {
      "id": "metalBoxBonded",
      "article": "250.148(C)",
      "title": "Metal box not bonded",
      "paraphrase": "Where circuit conductors are spliced or terminated in a metal box, the equipment grounding conductors that go with them are joined in the box and the box itself is connected to them, by a screw used only for grounding or by a listed grounding device.",
      "severity": "violation",
      "check": null
    },
    {
      "id": "kitchenSmallApplianceCircuits",
      "article": "210.11(C)(1)",
      "title": "Two small-appliance circuits",
      "paraphrase": "A dwelling needs at least two 20 A small-appliance branch circuits for the receptacle outlets of its kitchen, pantry, breakfast room and dining room. Listed here, not checked: the inspector never claims a full inspection.",
      "severity": "violation",
      "check": null
    }
  ],
  "sources": [
    {
      "id": "nfpa-70-2023",
      "kind": "real-world",
      "citation": "NFPA 70-2023 (National Electrical Code), cited by article number only; each paraphrase is written in our own words and reproduces no code text or table (realism charter, ADR 0003; P4 Q2: the 2023 edition). 240.4(D) and 250.148(C) are the numbering the P4 source pre-audit confirmed (electrical-realism-reviewer, 2026-11-17); 210.11(C)(1): number confirmed by the realism review 2026-11-17 against secondary sources; NFPA text not read. Which check kind runs each rule is the inspector's (F4.5); until then every rule here is listed, not checked.",
      "covers": [
        "rules.*.article"
      ]
    }
  ],
  "extensions": {}
}
];
