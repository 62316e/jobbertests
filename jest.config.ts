import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.(ts)$": ["ts-jest", { tsconfig: "tsconfig.json", useESM: true }],
  },
  extensionsToTreatAsEsm: [".ts"],
  verbose: true,
};

export default config;
