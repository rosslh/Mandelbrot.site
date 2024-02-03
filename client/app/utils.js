import fastJson from "fast-json-stringify";
export const stringify = fastJson({
  title: "Coords Schema",
  type: "object",
  properties: {
    re_min: { type: "number" },
    re_max: { type: "number" },
    im_min: { type: "number" },
    im_max: { type: "number" },
  },
});
