# Pronunciation & Prosody Assessment — Research Reference

State of the field as of April 2026. Used as the source-of-truth for Phase 7 of the v2 plan.

## TL;DR

There is no truly free, plug-and-play SpeechAce equivalent for prosody/intonation. The space splits into three tiers:

1. **Cheap commercial APIs** with prosody scores baked in — Azure is the clear winner on price/quality
2. **Open-source GOP pipelines** built on Kaldi or wav2vec2 — free but you assemble them yourself
3. **DIY prosody analysis** with Praat / parselmouth — totally free, low-level features only

For Habla v2, the answer is **Azure Speech Pronunciation Assessment** with `EnableProsodyAssessment=true`.

---

## 1. Commercial APIs

### Azure Speech Pronunciation Assessment (recommended for v2)
- Closest "real" SpeechAce competitor, dramatically cheaper
- Returns Accuracy, Fluency, Completeness, **Prosody** (stress, intonation, speed, rhythm)
- Error types: *Unexpected break*, *Missing break*, *Monotone*
- ~$1.32/hr standard, ~$0.66/hr short-audio REST endpoint (<30s clips)
- Free tier: 5 hours/month
- **Caveat**: prosody assessment is **en-US only** as of late 2025. For Spanish output we get accuracy/fluency only, no prosody.

### SpeechSuper
- SpeechAce's main direct competitor
- Same product shape: phoneme/word/sentence scoring, IELTS/PTE alignment
- 8 languages including Mandarin, German, French, Spanish, Korean, Japanese, Russian
- Scores rhythm, stress, tone, liaison
- Pricing opaque, starts ~$500 Starter tier. Free trial keys on request.

### SpeechAce
- Has a free trial — worth trying first since the product fits

### Others (transcription-first, no real prosody score)
- iSpeech, Google Cloud Speech-to-Text, Speechmatics

## 2. Open-source: the GOP family

Goodness of Pronunciation (GOP), originally Witt & Young (2000) — score how well an utterance matches expected phonemes via forced alignment.

| Repo | Notes |
|---|---|
| `kaldi-gop` (jimbozhang) | GMM-based Kaldi, classical baseline |
| `gop-pykaldi` (JazminVidal) | PyKaldi port of Kaldi's official DNN-GOP recipe, TDNN-F LibriSpeech model. Cleanest "run GOP today" repo. |
| `gop-ft` (JazminVidal) | Adds transfer learning on top of GOP-DNN |
| **`GOPT`** (YuanGongND) | ICASSP 2022 transformer, jointly scores accuracy/fluency/**prosody**/stress at phoneme/word/utterance levels. Pretrained model published. SpeechOcean762: 0.612 phone-level Pearson, 0.742 sentence-level. **Closest open-source thing to SpeechAce's full output.** |

Training/eval data:
- **SpeechOcean762** — free, ~5000 utterances with phoneme/word/utterance scores
- **EpaDB** — Argentinian L2 English

## 3. Wav2vec2 wave (2023–2025)

Field has largely moved off Kaldi GOP onto self-supervised models.

- **wav2vec2-XLSR + espeak alignment** — fine-tune for phoneme output, force-align against expected, flag mismatches. The `crazycloud/mispronunciation-detection-diagnosis-wav2vec2-and-llm` repo does exactly this and uses an LLM for human-readable feedback. **Pattern worth stealing wholesale.**
- **Articulatory feature detection** — Shahin et al. (Speech Communication, 2025): wav2vec2-based detection of articulatory features (place, manner, voicing) beats phoneme-level MDD because it can flag *novel* errors that don't appear in training data.
- **HuBERT, WavLM** — also used; backbone choice matters less than the fine-tuning recipe.

## 4. Intonation specifically

Genuinely harder than segmental pronunciation. Three layers:

**Low-level acoustic features (free, easy)**
- `parselmouth` — Python wrapper for Praat. F0 contours, intensity, formants, voice quality. What every prosody paper actually uses underneath.
- `pysptk` — pitch extraction (RAPT, SWIPE)
- `prosolia` (bootphon) — filterbank + Kaldi pitch extraction
- `myprosody` — Praat wrapper for higher-level features (f0 stats, intonation_index, articulation rate)

**Stylization / contour modeling**
- **CoPaSul** — Contour-based Parametric and Superpositional intonation stylization. Fits parametric models to F0 contours.

**Learned prosody scoring**
- GOPT — strongest published open-source prosody score
- Azure prosody — black box, but the error taxonomy (Monotone, Unexpected break, Missing break) is a reasonable target schema if rolling our own

**Honest state**: even commercial systems treat prosody as an aggregate score with a few error types, not the rich phoneme-level diagnosis you get for segmentals. "Did the rising intonation peak on the right syllable" still requires custom training data or hand-built F0/energy heuristics.

## 5. Recommendation matrix

| If you want... | Do this |
|---|---|
| Scores in a shipping app, fast | Azure Pronunciation Assessment, $1.32/hr |
| Research-credible pipeline, control | wav2vec2-XLSR + parselmouth + LLM-as-translator (crazycloud pattern) |
| To push the intonation frontier | Wide-open gap — no published model gives diagnostic intonation feedback |

## How this maps to Habla v2

- **Phase 7 default**: Azure Pronunciation Assessment + a thin parselmouth layer for Spanish monotone/intonation flags (since Azure prosody is en-US only)
- **Phase 7 fallback if Azure fails our needs**: SpeechSuper free trial, then GOPT self-hosted
- **v3 direction**: wav2vec2-XLSR fine-tuned for Spanish + LLM-translated feedback. Document, don't build yet.
