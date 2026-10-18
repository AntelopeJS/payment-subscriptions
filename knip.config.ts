import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: [
    "src/test/**/*.test.ts",
    "src/test/antelope.test.ts",
    "test/payment-provider/index.js",
    "test/boot-probe/index.js",
  ],
  ignoreBinaries: ["ajs"],
});
