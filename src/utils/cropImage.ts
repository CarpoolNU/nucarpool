import type { Area } from "react-easy-crop";

/**
 * `Area` is react-easy-crop's own type for the crop rectangle, rather than a
 * local shape or `any`. It is the contract this function shares with the
 * library, so borrowing it means a future major that reshapes the crop data
 * fails `tsc` here instead of at runtime - nothing tests this file, and the
 * only symptom would be a silently wrong avatar.
 */
export default function getCroppedImg(
  imageSrc: string,
  croppedAreaPixels: Area,
) {
  return new Promise<{ file: File; url: string }>((resolve, reject) => {
    const image = new Image();
    image.src = imageSrc;
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        return reject(new Error("Failed to get canvas context"));
      }

      canvas.width = croppedAreaPixels.width;
      canvas.height = croppedAreaPixels.height;

      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
      );

      canvas.toBlob(
        (blob) => {
          if (blob) {
            const file = new File([blob], "cropped-image.jpeg", {
              type: "image/jpeg",
            });
            const url = URL.createObjectURL(blob);
            resolve({ file, url });
          } else {
            reject(new Error("Canvas is empty"));
          }
        },
        "image/jpeg",
        0.7,
      );
    };

    image.onerror = () => {
      reject(new Error("Failed to load image"));
    };
  });
}
