import React from "react";

import { useAppStore } from "../store";

export default function ClipMeter({ inputNode }) {
  const { ac } = window;

  const ref = React.useRef();

  React.useEffect(() => {
    const canvas = ref.current;

    // wait until canvas is ready
    if (!canvas) {
      return;
    }

    // wait until input node is ready
    if (!inputNode) {
      return;
    }

    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const canvasCtx = canvas.getContext("2d");

    let isClipping = false;

    function draw() {
      requestAnimationFrame(draw);

      analyser.getByteTimeDomainData(dataArray);
      canvasCtx.fillStyle = "rgb(200, 200, 200)";
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = isClipping ? "rgb(255, 0, 0)" : "rgb(0, 0, 0)";

      canvasCtx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i += 1) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    }

    draw();

    function checkClipping(buffer) {
      isClipping = false;

      for (let i = 0; i < buffer.length; i += 1) {
        const absValue = Math.abs(buffer[i]);
        if (absValue >= 1) {
          isClipping = true;
          console.log("CLIPPING");
          break;
        }
      }
    }

    const meter = ac.createScriptProcessor(2048, 1, 1);
    meter.onaudioprocess = (e) => {
      const leftBuffer = e.inputBuffer.getChannelData(0);
      checkClipping(leftBuffer);

      // if we want to do this in stereo, we need 2 separate `isClipping` values
      // const rightBuffer = e.inputBuffer.getChannelData(1)
      // checkClipping(rightBuffer)
    };

    inputNode.connect(analyser);
    inputNode.connect(meter);
    meter.connect(ac.destination);

    return () => {
      inputNode.disconnect(analyser);
      inputNode.disconnect(meter);
      meter.disconnect(ac.destination);
    };
  }, [ref, inputNode]);

  return <canvas ref={ref} />;
}
