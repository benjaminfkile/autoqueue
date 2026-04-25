module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  // @octokit/rest v22+ is ESM-only; redirect to a CJS stub so Jest (CJS mode)
  // can import it without a SyntaxError.
  moduleNameMapper: {
    '^@octokit/rest$': '<rootDir>/__mocks__/@octokit/rest.js',
  },
  // Phase 2 coverage gate: protect the two files whose policy branches and
  // event emission this phase introduced. A drop below 80% line coverage on
  // either file fails `npm run coverage`.
  coverageThreshold: {
    'src/db/tasks.ts': {
      lines: 80,
    },
    'src/services/taskRunner.ts': {
      lines: 80,
    },
  },
};
