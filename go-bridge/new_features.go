package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

type broadcastResult struct {
	JID string `json:"jid"`
	ID  string `json:"id,omitempty"`
	Err string `json:"error,omitempty"`
}

func (b *Bridge) registerNewFeatureRoutes(r *mux.Router) {
	r.HandleFunc("/instances/{id}/send-broadcast", b.handleSendBroadcast).Methods("POST")
	r.HandleFunc("/instances/{id}/send-sticker", b.handleSendSticker).Methods("POST")
	r.HandleFunc("/instances/{id}/send-poll", b.handleSendPoll).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/poll-vote", b.handlePollVote).Methods("POST")
	r.HandleFunc("/instances/{id}/labels/edit", b.handleLabelEdit).Methods("POST")
	r.HandleFunc("/instances/{id}/labels/chat", b.handleLabelChat).Methods("POST")
	r.HandleFunc("/instances/{id}/labels/message", b.handleLabelMessage).Methods("POST")
	r.HandleFunc("/instances/{id}/chats/disappearing", b.handleChatDisappearing).Methods("POST")
}

func (b *Bridge) handleSendBroadcast(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int      `json:"account_id"`
		Text      string   `json:"text"`
		JIDs      []string `json:"jids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Text == "" {
		http.Error(w, "text is required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	var recipients []types.JID
	if len(req.JIDs) > 0 {
		for _, raw := range req.JIDs {
			jid, err := b.prepareRecipient(client, raw)
			if err != nil {
				continue
			}
			recipients = append(recipients, jid)
		}
		if len(recipients) == 0 {
			http.Error(w, "no valid recipients", 400)
			return
		}
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		contacts, err := client.Store.Contacts.GetAllContacts(ctx)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		for jid := range contacts {
			if jid.Server == types.DefaultUserServer {
				recipients = append(recipients, jid)
			}
		}
		if len(recipients) == 0 {
			http.Error(w, "no contacts found", 400)
			return
		}
	}

	results := make([]broadcastResult, 0, len(recipients))
	msg := &waProto.Message{Conversation: proto.String(req.Text)}

	for _, recipient := range recipients {
		sendCtx, sendCancel := context.WithTimeout(context.Background(), 15*time.Second)
		resp, sendErr := sendWithPreWarm(client, sendCtx, recipient, msg)
		sendCancel()

		result := broadcastResult{JID: recipient.ToNonAD().String()}
		if sendErr != nil {
			result.Err = sendErr.Error()
		} else {
			result.ID = string(resp.ID)
		}
		results = append(results, result)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":    true,
		"total":      len(results),
		"sent":       countSent(results),
		"failed":     countFailed(results),
		"recipients": results,
	})
}

func countSent(results []broadcastResult) int {
	count := 0
	for _, r := range results {
		if r.Err == "" {
			count++
		}
	}
	return count
}

func countFailed(results []broadcastResult) int {
	count := 0
	for _, r := range results {
		if r.Err != "" {
			count++
		}
	}
	return count
}

func (b *Bridge) handleSendSticker(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int    `json:"account_id"`
		JID       string `json:"jid"`
		MediaURL  string `json:"mediaUrl"`
		Image     string `json:"image"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	source := strings.TrimSpace(req.MediaURL)
	if source == "" {
		source = strings.TrimSpace(req.Image)
	}
	if source == "" {
		http.Error(w, "mediaUrl or image is required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	data, err := loadMediaBytes(source)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	uploadCtx, uploadCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer uploadCancel()

	mimeType := http.DetectContentType(data)
	uploaded, err := client.Upload(uploadCtx, data, whatsmeow.MediaStickerPack)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	now := time.Now().Unix()
	msg := &waProto.Message{
		StickerMessage: &waProto.StickerMessage{
			URL:               &uploaded.URL,
			DirectPath:        &uploaded.DirectPath,
			MediaKey:          uploaded.MediaKey,
			FileEncSHA256:     uploaded.FileEncSHA256,
			FileSHA256:        uploaded.FileSHA256,
			FileLength:        &uploaded.FileLength,
			Mimetype:          proto.String(mimeType),
			MediaKeyTimestamp: proto.Int64(now),
		},
	}

	sendCtx, sendCancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer sendCancel()
	resp, err := sendWithPreWarm(client, sendCtx, targetJid, msg)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (b *Bridge) handleSendPoll(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId              int      `json:"account_id"`
		JID                    string   `json:"jid"`
		Name                   string   `json:"name"`
		Text                   string   `json:"text"`
		Options                []string `json:"options"`
		SelectableOptionsCount int      `json:"selectableOptionsCount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}

	pollName := strings.TrimSpace(req.Name)
	if pollName == "" {
		pollName = strings.TrimSpace(req.Text)
	}
	if pollName == "" {
		http.Error(w, "name is required", 400)
		return
	}
	if len(req.Options) < 2 {
		http.Error(w, "at least 2 options are required", 400)
		return
	}
	if req.SelectableOptionsCount <= 0 || req.SelectableOptionsCount > len(req.Options) {
		req.SelectableOptionsCount = 1
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	pollMsg := client.BuildPollCreation(pollName, req.Options, req.SelectableOptionsCount)

	sendCtx, sendCancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer sendCancel()
	resp, err := sendWithPreWarm(client, sendCtx, targetJid, pollMsg)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (b *Bridge) handlePollVote(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int      `json:"account_id"`
		JID       string   `json:"jid"`
		MessageID string   `json:"message_id"`
		Options   []string `json:"options"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.MessageID == "" || len(req.Options) == 0 {
		http.Error(w, "message_id and options are required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	b.mu.Lock()
	cached, ok := b.messages[id][req.MessageID]
	b.mu.Unlock()
	if !ok || cached == nil || cached.Info.ID == "" {
		http.Error(w, "poll message not found in cache", 404)
		return
	}

	voteCtx, voteCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer voteCancel()
	voteMsg, err := client.BuildPollVote(voteCtx, &cached.Info, req.Options)
	if err != nil {
		http.Error(w, fmt.Sprintf("failed to build poll vote: %v", err), 500)
		return
	}

	sendCtx, sendCancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer sendCancel()
	resp, err := sendWithPreWarm(client, sendCtx, targetJid, voteMsg)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (b *Bridge) handleLabelEdit(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int    `json:"account_id"`
		LabelID   string `json:"labelId"`
		LabelName string `json:"labelName"`
		LabelColor int32 `json:"labelColor"`
		Deleted   *bool  `json:"deleted"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.LabelName == "" && (req.Deleted == nil || !*req.Deleted) {
		http.Error(w, "labelName is required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	isDeleted := false
	if req.Deleted != nil {
		isDeleted = *req.Deleted
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	err = client.SendAppState(ctx, appstate.BuildLabelEdit(req.LabelID, req.LabelName, req.LabelColor, isDeleted))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (b *Bridge) handleLabelChat(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int    `json:"account_id"`
		JID       string `json:"jid"`
		LabelID   string `json:"labelId"`
		Labeled   *bool  `json:"labeled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.JID == "" || req.LabelID == "" {
		http.Error(w, "jid and labelId are required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	isLabeled := true
	if req.Labeled != nil {
		isLabeled = *req.Labeled
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	err = client.SendAppState(ctx, appstate.BuildLabelChat(targetJid, req.LabelID, isLabeled))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (b *Bridge) handleLabelMessage(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int    `json:"account_id"`
		JID       string `json:"jid"`
		LabelID   string `json:"labelId"`
		MessageID string `json:"messageId"`
		Labeled   *bool  `json:"labeled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.JID == "" || req.LabelID == "" || req.MessageID == "" {
		http.Error(w, "jid, labelId and messageId are required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	isLabeled := true
	if req.Labeled != nil {
		isLabeled = *req.Labeled
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	err = client.SendAppState(ctx, appstate.BuildLabelMessage(targetJid, req.LabelID, req.MessageID, isLabeled))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (b *Bridge) handleChatDisappearing(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int    `json:"account_id"`
		JID       string `json:"jid"`
		Timer     string `json:"timer"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.JID == "" {
		http.Error(w, "jid is required", 400)
		return
	}

	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	duration, ok := whatsmeow.ParseDisappearingTimerString(req.Timer)
	if !ok {
		http.Error(w, "invalid timer value, use: off, 24h, 7d, 90d", 400)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	err = client.SetDisappearingTimer(ctx, targetJid, duration, time.Now())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"timer":    req.Timer,
		"duration": duration.Seconds(),
	})
}
