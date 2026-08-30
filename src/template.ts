import { CliError } from "./errors.js";

const missing = Symbol("missing");
type Missing = typeof missing;
type Value = unknown | Missing;

type Token =
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "symbol"; value: string }
  | { kind: "eof" };

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_-]/;

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (identifierStart.test(character)) {
      let value = character;
      index += 1;
      while (index < source.length && identifierPart.test(source[index]!)) {
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }
    if (
      /\d/.test(character) ||
      (character === "-" && /\d/.test(source[index + 1] ?? ""))
    ) {
      const match = source.slice(index).match(/^-?\d+(?:\.\d+)?/);
      if (!match) throw new CliError("EXPRESSION_INVALID", "Invalid number");
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        index += 1;
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index];
          if (escaped === undefined)
            throw new CliError(
              "EXPRESSION_INVALID",
              "Incomplete string escape",
            );
          index += 1;
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
            "'": "'",
          };
          value += escapes[escaped] ?? escaped;
        } else value += current;
      }
      if (!closed)
        throw new CliError("EXPRESSION_INVALID", "Unterminated string");
      tokens.push({ kind: "string", value });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (["==", "!=", ">=", "<="].includes(pair)) {
      tokens.push({ kind: "symbol", value: pair });
      index += 2;
      continue;
    }
    if (".[]()|,><".includes(character)) {
      tokens.push({ kind: "symbol", value: character });
      index += 1;
      continue;
    }
    throw new CliError(
      "EXPRESSION_INVALID",
      `Unsupported expression character ${JSON.stringify(character)}`,
    );
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Parser {
  readonly #tokens: Token[];
  readonly #context: Record<string, unknown>;
  #index = 0;

  constructor(source: string, context: Record<string, unknown>) {
    this.#tokens = tokenise(source);
    this.#context = context;
  }

  parse(): Value {
    const value = this.#parseOr();
    this.#expect("eof");
    return value;
  }

  #current(): Token {
    return this.#tokens[this.#index]!;
  }

  #advance(): Token {
    const token = this.#current();
    this.#index += 1;
    return token;
  }

  #matches(value: string): boolean {
    const token = this.#current();
    return (
      (token.kind === "symbol" && token.value === value) ||
      (token.kind === "identifier" && token.value === value)
    );
  }

  #accept(value: string): boolean {
    if (!this.#matches(value)) return false;
    this.#advance();
    return true;
  }

  #expect(value: string): Token {
    const token = this.#current();
    if (value === "eof" ? token.kind === "eof" : this.#matches(value))
      return this.#advance();
    throw new CliError(
      "EXPRESSION_INVALID",
      `Expected ${value} in template expression`,
    );
  }

  #parseOr(): Value {
    let value = this.#parseAnd();
    while (this.#accept("or")) {
      const right = this.#parseAnd();
      value = this.#truthy(value) || this.#truthy(right);
    }
    return value;
  }

  #parseAnd(): Value {
    let value = this.#parseComparison();
    while (this.#accept("and")) {
      const right = this.#parseComparison();
      value = this.#truthy(value) && this.#truthy(right);
    }
    return value;
  }

  #parseComparison(): Value {
    let value = this.#parseUnary();
    while (
      ["==", "!=", ">=", "<=", ">", "<"].some((operator) =>
        this.#matches(operator),
      )
    ) {
      const operator = (this.#advance() as { value: string }).value;
      const right = this.#parseUnary();
      if (value === missing || right === missing)
        throw new CliError(
          "EXPRESSION_MISSING",
          "Missing values cannot be compared without default(...) ",
        );
      switch (operator) {
        case "==":
          value = value === right;
          break;
        case "!=":
          value = value !== right;
          break;
        case ">=":
          value = (value as number | string) >= (right as number | string);
          break;
        case "<=":
          value = (value as number | string) <= (right as number | string);
          break;
        case ">":
          value = (value as number | string) > (right as number | string);
          break;
        case "<":
          value = (value as number | string) < (right as number | string);
      }
    }
    return value;
  }

  #parseUnary(): Value {
    if (this.#accept("not")) return !this.#truthy(this.#parseUnary());
    return this.#parseFiltered();
  }

  #parseFiltered(): Value {
    let value = this.#parsePrimary();
    while (this.#accept("|")) {
      const filter = this.#advance();
      if (filter.kind !== "identifier" || filter.value !== "default")
        throw new CliError(
          "EXPRESSION_FILTER_FORBIDDEN",
          "Only the default filter is available in template expressions v1",
        );
      this.#expect("(");
      const fallback = this.#parseOr();
      this.#expect(")");
      if (value === missing) value = fallback;
    }
    return value;
  }

  #parsePrimary(): Value {
    const token = this.#advance();
    if (token.kind === "number" || token.kind === "string") return token.value;
    if (token.kind === "symbol" && token.value === "(") {
      const value = this.#parseOr();
      this.#expect(")");
      return value;
    }
    if (token.kind !== "identifier")
      throw new CliError(
        "EXPRESSION_INVALID",
        "Expected a value or object path",
      );
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    if (token.value === "null") return null;

    let value: Value = Object.hasOwn(this.#context, token.value)
      ? this.#context[token.value]
      : missing;
    while (true) {
      if (this.#accept(".")) {
        const property = this.#advance();
        if (property.kind !== "identifier")
          throw new CliError(
            "EXPRESSION_INVALID",
            "Expected an object property",
          );
        value = this.#lookup(value, property.value);
        continue;
      }
      if (this.#accept("[")) {
        const key = this.#advance();
        if (
          key.kind !== "identifier" &&
          key.kind !== "string" &&
          key.kind !== "number"
        )
          throw new CliError(
            "EXPRESSION_INVALID",
            "Expected a map or list key",
          );
        const property = key.value;
        this.#expect("]");
        value = this.#lookup(value, property);
        continue;
      }
      break;
    }
    return value;
  }

  #lookup(value: Value, property: string | number): Value {
    if (value === missing) return missing;
    if (Array.isArray(value) && typeof property === "number")
      return property >= 0 && property < value.length
        ? value[property]
        : missing;
    if (isRecord(value) && typeof property === "string")
      return Object.hasOwn(value, property) ? value[property] : missing;
    return missing;
  }

  #truthy(value: Value): boolean {
    if (value === missing)
      throw new CliError(
        "EXPRESSION_MISSING",
        "Missing value requires an explicit default(...) filter",
      );
    return Boolean(value);
  }
}

export function evaluateExpression(
  source: string,
  context: Record<string, unknown>,
): unknown {
  if (source.length > 2_000)
    throw new CliError(
      "EXPRESSION_LIMIT",
      "Expression exceeds 2,000 characters",
    );
  const value = new Parser(source, context).parse();
  if (value === missing)
    throw new CliError(
      "EXPRESSION_MISSING",
      `Missing value in expression: ${source}`,
    );
  return value;
}

const expressionPattern = /{{([\s\S]*?)}}/g;

export function renderTemplateValue(
  value: string,
  context: Record<string, unknown>,
): unknown {
  const matches = [...value.matchAll(expressionPattern)];
  if (matches.length === 0) return value;
  if (matches.length > 64)
    throw new CliError(
      "EXPRESSION_LIMIT",
      "Template scalar exceeds 64 expressions",
    );

  if (matches.length === 1 && matches[0]![0] === value)
    return evaluateExpression(matches[0]![1]!.trim(), context);

  let output = "";
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    output += value.slice(cursor, index);
    const evaluated = evaluateExpression(match[1]!.trim(), context);
    if (evaluated !== null && typeof evaluated === "object")
      throw new CliError(
        "EXPRESSION_TYPE",
        "Embedded expressions must resolve to scalar values",
      );
    output += evaluated === null ? "null" : String(evaluated);
    cursor = index + match[0].length;
  }
  output += value.slice(cursor);
  return output;
}
