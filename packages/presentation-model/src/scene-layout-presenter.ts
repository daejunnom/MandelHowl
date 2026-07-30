import { GENERATED_SCENE_SPEC } from "../../contracts/src";

export interface CanonicalSceneLayout {
  readonly speakerCenterXPercent: number;
  readonly speakerCenterYPercent: number;
  readonly plateCenterXPercent: number;
  readonly plateCenterYPercent: number;
  readonly microphoneCenterXPercent: number;
  readonly microphoneCenterYPercent: number;
}

const horizontalMarginPercent = 10;
const speakerX = GENERATED_SCENE_SPEC.apparatus.speaker.position[0];
const plateX = GENERATED_SCENE_SPEC.apparatus.plate.position[0];
const microphoneX =
  GENERATED_SCENE_SPEC.apparatus.microphone.position[0];
const speakerY = GENERATED_SCENE_SPEC.apparatus.speaker.position[1];
const plateY = GENERATED_SCENE_SPEC.apparatus.plate.position[1];
const microphoneY =
  GENERATED_SCENE_SPEC.apparatus.microphone.position[1];
const minimumX = Math.min(speakerX, plateX, microphoneX);
const maximumX = Math.max(speakerX, plateX, microphoneX);
const minimumY = Math.min(speakerY, plateY, microphoneY);
const maximumY = Math.max(speakerY, plateY, microphoneY);

function horizontalPercent(positionX: number): number {
  const span = maximumX - minimumX;
  const normalized = span > 0 ? (positionX - minimumX) / span : 0.5;
  return (
    horizontalMarginPercent +
    normalized * (100 - horizontalMarginPercent * 2)
  );
}

function verticalPercent(positionY: number): number {
  const span = maximumY - minimumY;
  const normalized = span > 0 ? (positionY - minimumY) / span : 0.5;
  // Keep all three pieces inside the apparatus frame while preserving the
  // source coordinate system's top-to-bottom order.
  return 35 + normalized * 30;
}

/**
 * Browser-layout projection of the canonical normalized apparatus x-axis.
 * The outer ten percent remains available for cable and annotation framing.
 */
export const CANONICAL_SCENE_LAYOUT: CanonicalSceneLayout = Object.freeze({
  speakerCenterXPercent: horizontalPercent(speakerX),
  speakerCenterYPercent: verticalPercent(speakerY),
  plateCenterXPercent: horizontalPercent(plateX),
  plateCenterYPercent: verticalPercent(plateY),
  microphoneCenterXPercent: horizontalPercent(microphoneX),
  microphoneCenterYPercent: verticalPercent(microphoneY),
});
