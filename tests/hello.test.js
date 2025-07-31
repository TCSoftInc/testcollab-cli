/**
 * Simple hello world test to verify Jest is working correctly
 */

describe('Hello World', () => {
  test('should pass a basic test', () => {
    expect(1 + 1).toBe(2);
  });

  test('should work with strings', () => {
    const message = 'Hello, World!';
    expect(message).toBe('Hello, World!');
  });

  test('should work with arrays', () => {
    const numbers = [1, 2, 3];
    expect(numbers).toHaveLength(3);
    expect(numbers).toContain(2);
  });

  test('should work with objects', () => {
    const person = { name: 'TestCollab', type: 'CLI' };
    expect(person).toHaveProperty('name');
    expect(person.name).toBe('TestCollab');
  });

  test('should work with async operations', async () => {
    const asyncOperation = () => Promise.resolve('async result');
    const result = await asyncOperation();
    expect(result).toBe('async result');
  });
});
