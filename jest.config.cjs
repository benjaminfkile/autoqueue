module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  // @octokit/rest v22+ is ESM-only; redirect to a CJS stub so Jest (CJS mode)
  // can import it without a SyntaxError.
  moduleNameMapper: {
    '^@octokit/rest$': '<rootDir>/__mocks__/@octokit/rest.js',
  },
};
