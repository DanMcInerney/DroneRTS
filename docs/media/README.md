# DroneRTS demo

`dronerts.mp4` is the complete user-supplied demo, recompressed from the original H.264 recording. It retains the 1920 × 1080 resolution, approximately 93.37-second duration, and audio. H.264/yuv420p video, AAC audio, and a front-loaded MP4 index support browser playback.

`dronerts-preview.gif` is a silent excerpt beginning at **1:10** and continuing through the end of the recording, approximately **23.4 seconds**. It is scaled to 960 pixels wide at ten frames per second, loops continuously, and occupies 4,494,501 bytes. The project README embeds it and links to the full MP4. Neither asset establishes gameplay performance beyond what the recording actually shows; source-specific measurements live in the checked-in QA reports.

The full MP4 was uploaded using `gh api` against the same user-attachment endpoint used by current GitHub CLI releases. The resulting [GitHub video attachment](https://github.com/user-attachments/assets/514f1d77-928d-41aa-8769-caf24d784f55) is embedded as a native player inside the README's expandable demo section. The checked-in MP4 remains available as a download. No browser login, issue, or comment was needed for the upload.

GitHub strips arbitrary HTML video tags from README Markdown; its own attachment URL on a separate line creates the native player. Verify anonymous playback after the repository is public; private-repository attachments require repository access. See [GitHub's attachment documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
