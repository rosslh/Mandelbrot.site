import type { JSX } from "preact";
import { canRecordAnimation } from "../ZoomAnimator";
import { logEvent } from "../analytics";
import { useApp } from "./AppContext";
import {
  AnimateIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  HideIcon,
  PinIcon,
  SaveIcon,
  ShowIcon,
} from "./icons";

function toggleFullScreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.body.requestFullscreen();
  }
}

export function ButtonBar(): JSX.Element {
  const { map, ui } = useApp();
  const isFullscreen = ui.isFullscreen.value;
  // Browsers without Blob can't build a download; without MediaRecorder /
  // canvas captureStream / a supported codec they can't record video. Either
  // feature's button disappears entirely on such browsers.
  const canSaveImage = typeof Blob !== "undefined";
  const canAnimate = canRecordAnimation();

  const share = () => {
    const shareUrl = map.getShareUrl();
    // Pin the current view to the sidebar (persisted to localStorage) so it
    // can be revisited later, and keep copying the link to the clipboard.
    ui.pinLocation(shareUrl);
    navigator.clipboard.writeText(shareUrl).then(() => {
      alert("The URL for this view has been copied and pinned!");
    });
    void logEvent(map, "share");
  };

  return (
    <div class="button-wrapper mobile-hidden">
      {canSaveImage && (
        <button
          id="saveImage"
          title="Save image"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            ui.saveImageModalOpen.value = !ui.saveImageModalOpen.value;
          }}
        >
          <SaveIcon />
        </button>
      )}
      {canAnimate && (
        <button
          id="animateZoom"
          title="Generate zoom animation"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            ui.animateModalOpen.value = !ui.animateModalOpen.value;
          }}
        >
          <AnimateIcon />
        </button>
      )}
      <button
        id="shareButton"
        title="Share current view"
        type="button"
        onClick={share}
      >
        <PinIcon />
      </button>
      <button
        id="hideControls"
        title="Hide controls"
        type="button"
        onClick={() => document.body.classList.add("hide-overlays")}
      >
        <HideIcon />
      </button>
      <button
        id="showControls"
        title="Show controls"
        type="button"
        onClick={() => document.body.classList.remove("hide-overlays")}
      >
        <ShowIcon />
      </button>
      <button
        id="exitFullScreen"
        title="Exit full screen"
        type="button"
        style={isFullscreen ? { display: "inline-block" } : undefined}
        onClick={toggleFullScreen}
      >
        <ExitFullscreenIcon />
      </button>
      <button
        id="fullScreen"
        title="Full screen"
        type="button"
        style={isFullscreen ? { display: "none" } : undefined}
        onClick={toggleFullScreen}
      >
        <FullscreenIcon />
      </button>
    </div>
  );
}
