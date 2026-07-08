interface Shape {
  kind: string;
}

const epsilon: number = 5;

function zeta(shape: Shape): string {
  return shape.kind;
}

module.exports = { epsilon, zeta };
