export class Option {
  constructor(value, present) {
    this.val = value;
    this.isSome = present;
  }

  static some(value) {
    return new Option(value, true);
  }

  static none() {
    return new Option(undefined, false);
  }
}
