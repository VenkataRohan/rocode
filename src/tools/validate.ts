// Hand-rolled validation for the small JSON Schema subset our Tools use:
// a top-level object with `properties` (string / integer / number / boolean,
// optional `minimum`) and `required`. Messages are written for the Model to act on.

type PropertySchema = { type?: string; minimum?: number };
type ObjectSchema = { properties?: Record<string, PropertySchema>; required?: string[] };

/** Returns a description of the first problem found, or null if `args` fits `schema`. */
export function validateArguments(schema: Record<string, unknown>, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `expected a JSON object, got ${describeType(args)}.`;
  }

  const { properties = {}, required = [] } = schema as ObjectSchema;
  const values = args as Record<string, unknown>;

  for (const name of required) {
    if (values[name] === undefined) return `missing required property "${name}".`;
  }
  for (const [name, property] of Object.entries(properties)) {
    const value = values[name];
    if (value === undefined) continue;
    const problem = checkProperty(property, value);
    if (problem) return `"${name}" ${problem}.`;
  }
  return null;
}

function checkProperty(property: PropertySchema, value: unknown): string | null {
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return `must be a string, got ${describeType(value)}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `must be a boolean, got ${describeType(value)}`;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number") return `must be ${withArticle(property.type)}, got ${describeType(value)}`;
      if (property.type === "integer" && !Number.isInteger(value)) return `must be an integer, got ${value}`;
      if (property.minimum !== undefined && value < property.minimum) {
        return `must be at least ${property.minimum}, got ${value}`;
      }
      break;
  }
  return null;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const withArticle = (type: string) => (type === "integer" ? "an integer" : `a ${type}`);
