# NebulaX project context

Read `README.md` before planning or changing this project. It contains the RailGuard AI / PS3 hackathon brief and the intended MVP.

- Prefer the Python and Streamlit stack specified in the brief; keep the solo build simple and modular.
- Use automatic Isolation Forest training as the primary detector. Add XGBoost only when labelled fault data exists.
- Let Python/ML process telemetry; give the AI reasoning layer summarized findings and supporting evidence.
- Preserve working functionality, make the smallest necessary changes, handle missing data gracefully, auto-detect numeric sensor columns, and cache model training.
- Never invent accuracy, confidence, model performance, or diagnostic evidence. Distinguish anomaly/risk indicators from verified faults and calibrated probabilities.
- Complete the five-screen MVP before advanced models. The diagnostic chat panel is optional.
- Follow the user's current request for the scope of each task. This saved brief alone is not an instruction to start implementing the application.
