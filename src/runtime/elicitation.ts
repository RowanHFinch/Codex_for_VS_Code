export type FormValue = string | number | boolean | string[];
export type FormField = {
  name: string;
  title: string;
  description?: string;
  required: boolean;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  options?: { value: string; label: string }[];
  default?: FormValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
};
function fail(): never {
  throw new Error('Unsupported or invalid MCP form. No answers were sent.');
}
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : fail();
const keys = (value: Record<string, any>, allowed: string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
};
const text = (value: unknown, max: number): string =>
  typeof value === 'string' && value.length <= max ? value : fail();
const bound = (value: unknown, integer = false): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'number' && Number.isFinite(value) && (!integer || (Number.isSafeInteger(value) && value >= 0))
      ? value
      : fail();

// Whitelist the native flat MCP schema; never silently drop an unfamiliar constraint.
export function elicitationFields(schema: unknown): FormField[] {
  const s = object(schema);
  keys(s, ['$schema', 'type', 'properties', 'required', 'additionalProperties']);
  if (s.type !== 'object' || (s.additionalProperties !== undefined && s.additionalProperties !== false)) fail();
  if (s.$schema !== undefined) text(s.$schema, 500);
  const properties = object(s.properties),
    names = Object.keys(properties);
  if (names.length > 20 || JSON.stringify(schema).length > 32_000) fail();
  const required = s.required ?? [];
  if (
    !Array.isArray(required) ||
    new Set(required).size !== required.length ||
    required.some(name => !names.includes(name))
  )
    fail();
  return names.map(name => {
    if (!name.length || name.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(name)) fail();
    const p = object(properties[name]);
    const f: FormField = {
      name,
      title: p.title === undefined ? name : text(p.title, 300),
      description: p.description === undefined ? undefined : text(p.description, 2000),
      required: required.includes(name),
      type: p.type,
    };
    const common = ['type', 'title', 'description', 'default'];
    const options = (source: Record<string, any>, array = false) => {
      if (source.enum !== undefined) {
        keys(source, array ? ['type', 'enum'] : [...common, 'enum', 'enumNames']);
        if (source.type !== 'string' || !Array.isArray(source.enum)) fail();
        if (
          source.enumNames !== undefined &&
          (!Array.isArray(source.enumNames) || source.enumNames.length !== source.enum.length)
        )
          fail();
        return source.enum.map((value: unknown, i: number) => ({
          value: text(value, 1000),
          label: source.enumNames === undefined ? text(value, 1000) : text(source.enumNames[i], 300),
        }));
      }
      const variants = source[array ? 'anyOf' : 'oneOf'];
      keys(source, array ? ['anyOf'] : [...common, 'oneOf']);
      if (!Array.isArray(variants)) fail();
      return variants.map((value: unknown) => {
        const v = object(value);
        keys(v, ['const', 'title']);
        return { value: text(v.const, 1000), label: text(v.title, 300) };
      });
    };
    if (p.type === 'string' && (p.enum !== undefined || p.oneOf !== undefined)) f.options = options(p);
    else if (p.type === 'string') {
      keys(p, [...common, 'minLength', 'maxLength', 'format']);
      f.minLength = bound(p.minLength, true);
      f.maxLength = bound(p.maxLength, true);
      if (p.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(p.format)) fail();
      f.format = p.format;
    } else if (p.type === 'number' || p.type === 'integer') {
      keys(p, [...common, 'minimum', 'maximum']);
      f.minimum = bound(p.minimum);
      f.maximum = bound(p.maximum);
    } else if (p.type === 'boolean') keys(p, common);
    else if (p.type === 'array') {
      keys(p, [...common, 'items', 'minItems', 'maxItems']);
      f.options = options(object(p.items), true);
      f.minItems = bound(p.minItems, true);
      f.maxItems = bound(p.maxItems, true);
    } else fail();
    if (
      f.options &&
      (!f.options.length || f.options.length > 50 || new Set(f.options.map(o => o.value)).size !== f.options.length)
    )
      fail();
    for (const [min, max] of [
      [f.minLength, f.maxLength],
      [f.minimum, f.maximum],
      [f.minItems, f.maxItems],
    ])
      if (min !== undefined && max !== undefined && min > max) fail();
    if (p.default !== undefined) {
      validateField(f, p.default);
      f.default = p.default;
    }
    return f;
  });
}

function validDate(value: string) {
  const date = new Date(value + 'T00:00:00Z');
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function validateField(f: FormField, value: unknown) {
  if (f.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > 50 ||
      new Set(value).size !== value.length ||
      value.some(v => !f.options?.some(o => o.value === v)) ||
      value.length < (f.minItems ?? 0) ||
      value.length > (f.maxItems ?? 50)
    )
      fail();
  } else if (f.type === 'boolean') {
    if (typeof value !== 'boolean') fail();
  } else if (f.type === 'number' || f.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (f.type === 'integer' && !Number.isSafeInteger(value)) ||
      (f.minimum !== undefined && value < f.minimum) ||
      (f.maximum !== undefined && value > f.maximum)
    )
      fail();
  } else {
    if (
      typeof value !== 'string' ||
      value.length > 10_000 ||
      [...value].length < (f.minLength ?? 0) ||
      [...value].length > (f.maxLength ?? 10_000) ||
      (f.options && !f.options.some(o => o.value === value))
    )
      fail();
    if (f.format === 'email' && !/^[^\s@]+@[^\s@]+$/.test(value)) fail();
    if (f.format === 'uri') {
      // URL() normalizes spaces/control characters; validate the original RFC 3986 characters first.
      const remainder = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '');
      if (
        !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
        /[^A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]/.test(value) ||
        /%(?![\dA-Fa-f]{2})/.test(value) ||
        value.split('#').length > 2 ||
        /[\[\]]/.test(remainder)
      )
        fail();
      const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
      if (
        authority !== undefined &&
        !/^(?:[A-Za-z0-9._~!$&'()*+,;=:%-]*@)?(?:\[[A-Za-z0-9:._~!$&'()*+,;=%-]+\]|[A-Za-z0-9._~!$&'()*+,;=%-]*)(?::\d*)?$/.test(
          authority,
        )
      )
        fail();
      try {
        new URL(value);
      } catch {
        fail();
      }
    }
    if (f.format === 'date' && !validDate(value)) fail();
    if (
      f.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(
        value,
      ) ||
        !validDate(value.slice(0, 10)) ||
        !Number.isFinite(Date.parse(value)))
    )
      fail();
  }
}
export function validateElicitation(fields: FormField[], content: unknown): Record<string, FormValue> {
  const values = object(content);
  if (JSON.stringify(values).length > 100_000 || Object.keys(values).some(name => !fields.some(f => f.name === name)))
    fail();
  for (const field of fields) {
    if (!Object.hasOwn(values, field.name)) {
      if (field.required) fail();
    } else validateField(field, values[field.name]);
  }
  return values as Record<string, FormValue>;
}
