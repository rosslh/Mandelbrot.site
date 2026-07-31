import snakeCase from "lodash/snakeCase";
import type MandelbrotMap from "./MandelbrotMap";
import * as api from "./api";

/** Records a usage event (an image save, a share) with the view it happened
 * at. Fire-and-forget: analytics must never block or break the action. */
export async function logEvent(
  map: MandelbrotMap,
  eventName: "imageSave" | "share",
) {
  await api.client?.from("events").insert([
    {
      event_name: snakeCase(eventName),
      share_url: map.getShareUrl(),
      re: String(map.config.re),
      im: String(map.config.im),
      zoom: map.config.zoom,
      iterations: map.config.maxIterations,
      session_id: api.sessionId,
    },
  ]);
}
