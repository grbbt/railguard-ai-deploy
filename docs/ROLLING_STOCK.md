# Singapore rolling-stock visual reference

The dashboard's original procedural model is visually inspired by the **Alstom MOVIA R151** used on Singapore's North–South and East–West Lines. It is a recognisable presentation model, not a manufacturer CAD model, exact replica, inspection drawing or claim that an uploaded train identifier belongs to this fleet.

## References inspected

- [LTA: East–West Line, R151 rolling-stock exterior image](https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network/east_west_line.html). The linked official exterior illustration was visually inspected for the black swept cab face, white/silver cheeks, dark panoramic glazing, paired doors, red roofline and green belt beneath the windows.
- [SMRT Group Review 2023/24](https://www.smrt.com.sg/getmedia/46e2f247-8c22-443f-b272-661c552c09ea/SMRT-Group-Review-23_24.pdf), printed pages 27–28 (PDF page 15), “Introducing R151 Trains to NSEWL”. The photograph of the actual train was visually inspected to check the cab silhouette, livery, light locations and underfloor appearance. Launch-ceremony ribbons are omitted.
- [Alstom: first new Singapore NSEWL trains, 1 June 2023](https://www.alstom.com/press-releases-news/2023/6/alstom-reveals-first-new-trains-north-south-east-west-lines-singapore). Establishes the R151 programme's six-car trainset formation and large windows.
- [LTA: first batch entering passenger service, June 2023](https://www.lta.gov.sg/content/ltagov/en/newsroom/2023/6/news-releases/first-batch-of-new-north-south-and-east-west-lines--trains-to-be.html). Establishes the train's Singapore NSEWL context and condition-monitoring features.

These sources informed an original code-generated model. Their photographs are not bundled, redistributed or loaded by the application.

## Geometry and interaction

The chosen presentation scale is approximately 23 m long and 3.2 m wide per carriage, with four paired passenger doors on each side, two bogies and eight wheels per carriage. These dimensions and the concealed brake, suspension and traction equipment are approximate modelling choices, not verified R151 engineering measurements. The complete overview contains six carriages, with outward-facing cabs at the two ends and intermediate gangways.

The car, trainset, running-gear and exploded views share the same component evidence. Carriage buttons change the visible geometry only. The telemetry schema does not establish individual-carriage or wheel positions, and the UI explicitly labels this limitation. Component highlighting comes from the actual supplied component status; it does not invent carriage-specific faults. The display text “SINGAPORE” is a visual identifier, not a live service destination. Grey/unknown is retained where evidence is unavailable.

Meshes are batched by material within selectable groups and generated locally. No external model, texture, font or CDN is required. Camera fitting projects the model bounds through the available viewport aspect ratio, including phone layouts. Controls support pointer input and keyboard selection; an interactive component diagram remains available if WebGL fails. The canvas uses demand rendering when rotation is paused, capped device-pixel ratio and disposable GPU resources.
