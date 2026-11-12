"""Strict JSON decoding shared by authored projects and source archives."""

import json
import math


def loads(text):
    def finite_number(value, parse):
        result = parse(value)
        try:
            if math.isfinite(result):
                return result
        except OverflowError:
            pass  # Arbitrary-precision Python integers must also fit the viewer.
        raise ValueError(f"Non-finite JSON number {value!r} is not allowed")

    def reject_constant(value):
        raise ValueError(f"Non-finite JSON number {value!r} is not allowed")

    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON property {key!r}")
            result[key] = value
        return result

    return json.loads(text, parse_float=lambda value: finite_number(value, float),
                      parse_int=lambda value: finite_number(value, int), parse_constant=reject_constant,
                      object_pairs_hook=unique_keys)
