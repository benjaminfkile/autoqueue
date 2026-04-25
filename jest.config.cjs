module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  // The web/ workspace runs its own test suite under Vitest. Jest can't load
  // those files (vitest is ESM-only), so keep its discovery limited to the
  // server tree.
  testPathIgnorePatterns: ['/node_modules/', '/web/'],
  // @octokit/rest v22+ is ESM-only; redirect to a CJS stub so Jest (CJS mode)
  // can import it without a SyntaxError.
  moduleNameMapper: {
    '^@octokit/rest$': '<rootDir>/__mocks__/@octokit/rest.js',
  },
  // Coverage gates: each phase locks in coverage on the files it added or
  // significantly extended. A drop below 80% line coverage on any of these
  // files fails `npm run coverage`.
  coverageThreshold: {
    // Phase 2: failure-policy branches and event emission.
    'src/db/tasks.ts': {
      lines: 80,
    },
    'src/services/taskRunner.ts': {
      lines: 80,
    },
    // Phase 3: SSE/log endpoints on tasksRouter and the worker-status route
    // on systemRouter that the GUI depends on.
    'src/routers/tasksRouter.ts': {
      lines: 80,
    },
    'src/routers/systemRouter.ts': {
      lines: 80,
    },
  },
};
