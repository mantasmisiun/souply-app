/* global jest */
// Jest setup — runs before each test file.
//
// Mock @react-native-async-storage/async-storage with its official in-memory
// jest mock. Several utils import AsyncStorage at module load (e.g.
// utils/locationStorage, which utils/splitOptions pulls in), and without this
// the unmockable native module throws on require, failing the whole suite.
jest.mock('@react-native-async-storage/async-storage', () =>
    require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
