export const syntheticCases = [
  {
    caseId: "OR-204",
    procedure: "Synthetic thyroid procedure",
    specimenName: "Left thyroid lobe",
    anatomicalStructure: "thyroid lobe",
    laterality: "LEFT",
    disposition: "PERMANENT_PATHOLOGY",
    containerCount: 1,
    labelCode: "SL-OR204-01",
    approvedAliases: ["thyroid lobe", "lobe of thyroid"],
  },
  {
    caseId: "OR-318",
    procedure: "Synthetic breast procedure",
    specimenName: "Right breast tissue",
    anatomicalStructure: "breast tissue",
    laterality: "RIGHT",
    disposition: "FRESH",
    containerCount: 2,
    labelCode: "SL-OR318-02",
    approvedAliases: ["breast tissue", "breast specimen"],
  },
];

export const primaryDemoCase = syntheticCases[0];
