package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/zylar06/video-agent/internal/analysis/asr"
	"github.com/zylar06/video-agent/internal/domain"
	"github.com/zylar06/video-agent/internal/media"
)

type Config struct {
	BaseURL, Model, APIKey string
	HTTPClient             *http.Client
}

func ConfigFromEnv(prefix string) Config {
	return Config{BaseURL: os.Getenv(prefix + "_BASE_URL"), Model: os.Getenv(prefix + "_MODEL"), APIKey: os.Getenv(prefix + "_API_KEY"), HTTPClient: http.DefaultClient}
}

// ConfigFromEnvAliases lets Video Agent reuse compatible GoClip environment
// groups without sharing GoClip's encrypted SQLite secrets database.
func ConfigFromEnvAliases(prefixes ...string) Config {
	for _, prefix := range prefixes {
		config := ConfigFromEnv(prefix)
		if config.BaseURL != "" || config.Model != "" || config.APIKey != "" {
			return config
		}
	}
	return Config{HTTPClient: http.DefaultClient}
}

type OpenAITranscriber struct{ Config Config }

// QwenASR adapts Qwen3 ASR's OpenAI-compatible chat endpoint.  The service
// accepts audio in five-minute windows; extracting compact audio here keeps
// video bytes and browser uploads out of the model request.
type QwenASR struct {
	Config Config
	Tools  media.Tools
}

type OpenAIText struct{ Config Config }

// Complete answers one prompt under the editing assistant's own system message.
// @param ctx - cancellation for the request.
// @param prompt - the user turn.
// @returns the model's reply.
func (p OpenAIText) Complete(ctx context.Context, prompt string) (string, error) {
	return p.CompleteWith(ctx, TextSystemPrompt, prompt)
}

// TextSystemPrompt is the system message for requests about what to cut. It
// forbids inventing timestamps because a timestamp is the one thing this system
// derives rather than asks for.
const TextSystemPrompt = "你是本地视频剪辑助手。只按用户请求提取剪辑意图，不要编造时间戳。"

// CompleteWith answers one prompt under a caller-supplied system message.
//
// A caller that is not asking for an edit — naming what a loud second sounds
// like, for instance — needs its own instruction, and sharing one system message
// would put editing rules on a task that is not editing.
//
// @param ctx - cancellation for the request.
// @param system - the system message for this request.
// @param prompt - the user turn.
// @returns the model's reply.
func (p OpenAIText) CompleteWith(ctx context.Context, system, prompt string) (string, error) {
	if p.Config.BaseURL == "" || p.Config.Model == "" || p.Config.APIKey == "" {
		return "", errors.New("model provider unavailable: text provider is not configured")
	}
	payload := map[string]any{"model": p.Config.Model, "temperature": 0, "messages": []any{map[string]string{"role": "system", "content": system}, map[string]string{"role": "user", "content": prompt}}}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(p.Config.BaseURL, "chat/completions"), bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+p.Config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client(p.Config).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("text provider returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
		return "", errors.New("text provider returned empty response")
	}
	return strings.TrimSpace(decoded.Choices[0].Message.Content), nil
}

func (p OpenAITranscriber) Transcribe(ctx context.Context, asset domain.MediaAsset) ([]asr.Cue, error) {
	if p.Config.BaseURL == "" || p.Config.Model == "" || p.Config.APIKey == "" {
		return nil, errors.New("model provider unavailable: ASR provider is not configured")
	}
	f, err := os.Open(asset.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	if err := form.WriteField("model", p.Config.Model); err != nil {
		return nil, err
	}
	if err := form.WriteField("response_format", "verbose_json"); err != nil {
		return nil, err
	}
	if err := form.WriteField("timestamp_granularities[]", "segment"); err != nil {
		return nil, err
	}
	part, err := form.CreateFormFile("file", filepath.Base(asset.Path))
	if err != nil {
		return nil, err
	}
	if _, err = io.Copy(part, f); err != nil {
		return nil, err
	}
	if err = form.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(p.Config.BaseURL, "audio/transcriptions"), &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.Config.APIKey)
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := client(p.Config).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("ASR provider returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var decoded struct {
		Text     string `json:"text"`
		Segments []struct {
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, fmt.Errorf("invalid ASR response: %w", err)
	}
	if len(decoded.Segments) > 0 {
		out := make([]asr.Cue, 0, len(decoded.Segments))
		for i, seg := range decoded.Segments {
			if strings.TrimSpace(seg.Text) != "" && seg.End > seg.Start {
				out = append(out, asr.Cue{Index: i + 1, StartUS: int64(seg.Start*1e6 + 0.5), EndUS: int64(seg.End*1e6 + 0.5), Text: strings.TrimSpace(seg.Text)})
			}
		}
		return out, nil
	}
	if strings.TrimSpace(decoded.Text) == "" {
		return nil, errors.New("ASR provider returned empty transcript")
	}
	return []asr.Cue{{Index: 1, StartUS: 0, EndUS: asset.DurationUS, Text: strings.TrimSpace(decoded.Text)}}, nil
}

func (p QwenASR) Transcribe(ctx context.Context, asset domain.MediaAsset) ([]asr.Cue, error) {
	if p.Config.BaseURL == "" || p.Config.Model == "" || p.Config.APIKey == "" {
		return nil, errors.New("model provider unavailable: ASR provider is not configured")
	}
	if !asset.HasAudio {
		return nil, errors.New("asset has no audio track")
	}
	tools := p.Tools
	if tools.FFmpeg == "" {
		tools = media.Default()
	}
	const windowUS int64 = 240_000_000
	var cues []asr.Cue
	for start := int64(0); start < asset.DurationUS; start += windowUS {
		end := min(start+windowUS, asset.DurationUS)
		file, err := os.CreateTemp("", "video-agent-asr-*.mp3")
		if err != nil {
			return nil, err
		}
		path := file.Name()
		_ = file.Close()
		_, err = media.Run(ctx, tools.FFmpeg, "-nostdin", "-v", "error", "-ss", fmt.Sprintf("%.3f", float64(start)/1e6), "-t", fmt.Sprintf("%.3f", float64(end-start)/1e6), "-i", asset.Path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-y", path)
		if err != nil {
			_ = os.Remove(path)
			return nil, err
		}
		data, readErr := os.ReadFile(path)
		_ = os.Remove(path)
		if readErr != nil {
			return nil, readErr
		}
		if len(data) == 0 || len(data) > 10<<20 {
			return nil, errors.New("prepared ASR audio is empty or exceeds the provider limit")
		}
		payload := map[string]any{
			"model":       p.Config.Model,
			"messages":    []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "input_audio", "input_audio": map[string]string{"data": "data:audio/mpeg;base64," + base64.StdEncoding.EncodeToString(data)}}}}},
			"asr_options": map[string]any{"enable_itn": true},
		}
		body, _ := json.Marshal(payload)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(p.Config.BaseURL, "chat/completions"), bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+p.Config.APIKey)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client(p.Config).Do(req)
		if err != nil {
			return nil, err
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("Qwen ASR returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		var decoded struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
			return nil, errors.New("Qwen ASR returned empty transcript")
		}
		cues = append(cues, asr.Cue{Index: len(cues) + 1, StartUS: start, EndUS: end, Text: strings.TrimSpace(decoded.Choices[0].Message.Content)})
	}
	return cues, nil
}

type OpenAIVision struct{ Config Config }

// DescribePrompt is the fixed instruction used when indexing an asset: a neutral
// description that a later keyword search can hit.
const DescribePrompt = "用一句简洁中文描述这帧画面中可核对的主体、动作和场景；不要猜测画外信息。"

// Ask sends one image with an arbitrary instruction and returns the model's
// answer. It exists so a caller can interrogate the video about a specific thing
// ("is there a flying saucer in this frame?") instead of only ever producing the
// one fixed description used at index time.
func (p OpenAIVision) Ask(ctx context.Context, imagePath, prompt string) (string, error) {
	if p.Config.BaseURL == "" || p.Config.Model == "" || p.Config.APIKey == "" {
		return "", errors.New("model provider unavailable: vision provider is not configured")
	}
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return "", err
	}
	payload := map[string]any{"model": p.Config.Model, "temperature": 0, "messages": []any{map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": prompt},
			map[string]any{"type": "image_url", "image_url": map[string]string{
				"url": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data),
			}},
		},
	}}}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(p.Config.BaseURL, "chat/completions"), bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+p.Config.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client(p.Config).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("vision provider returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
		return "", errors.New("vision provider returned empty response")
	}
	return strings.TrimSpace(decoded.Choices[0].Message.Content), nil
}

func (p OpenAIVision) Describe(ctx context.Context, evidence []domain.Evidence) (map[string]string, error) {
	if p.Config.BaseURL == "" || p.Config.Model == "" || p.Config.APIKey == "" {
		return nil, errors.New("model provider unavailable: vision provider is not configured")
	}
	out := map[string]string{}
	for _, e := range evidence {
		if len(e.FrameRefs) == 0 {
			continue
		}
		text, err := p.Ask(ctx, e.FrameRefs[0], DescribePrompt)
		if err != nil {
			return nil, err
		}
		out[e.ID] = text
	}
	return out, nil
}

func endpoint(base, suffix string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		return base + "/" + suffix
	}
	return base + "/v1/" + suffix
}
func client(c Config) *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}
