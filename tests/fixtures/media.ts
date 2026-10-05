// Synthetic ffprobe evidence for local byte fixtures, not actual encoded media.
export const videoProbeJson = JSON.stringify({
  format: { format_name: 'mp4', duration: '10', tags: { major_brand: 'isom' } },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360, pix_fmt: 'yuv420p', avg_frame_rate: '25/1' }],
});
