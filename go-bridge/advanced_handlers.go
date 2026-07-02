package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

const receivedMessageCacheLimit = 250

type advancedRequest struct {
	AccountID       int      `json:"account_id"`
	JID             string   `json:"jid"`
	Number          string   `json:"number"`
	MessageID       string   `json:"message_id"`
	Sender          string   `json:"sender"`
	Text            string   `json:"text"`
	QuotedText      string   `json:"quoted_text"`
	Reaction        string   `json:"reaction"`
	Name            string   `json:"name"`
	Address         string   `json:"address"`
	URL             string   `json:"url"`
	Latitude        float64  `json:"latitude"`
	Longitude       float64  `json:"longitude"`
	VCard           string   `json:"vcard"`
	Phone           string   `json:"phone"`
	Action          string   `json:"action"`
	State           string   `json:"state"`
	Media           string   `json:"media"`
	DurationSeconds int64    `json:"duration_seconds"`
	Participants    []string `json:"participants"`
	Topic           string   `json:"topic"`
	Code            string   `json:"code"`
	Locked          *bool    `json:"locked"`
	Announce        *bool    `json:"announce"`
}

func (b *Bridge) registerAdvancedRoutes(r *mux.Router) {
	r.HandleFunc("/instances/{id}/send-location", b.handleSendLocation).Methods("POST")
	r.HandleFunc("/instances/{id}/send-contact", b.handleSendContact).Methods("POST")
	r.HandleFunc("/instances/{id}/send-reply", b.handleSendReply).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/react", b.handleMessageReact).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/read", b.handleMessageRead).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/edit", b.handleMessageEdit).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/delete", b.handleMessageDelete).Methods("POST")
	r.HandleFunc("/instances/{id}/messages/download", b.handleMessageDownload).Methods("POST")
	r.HandleFunc("/instances/{id}/presence", b.handlePresence).Methods("POST")
	r.HandleFunc("/instances/{id}/contacts/check", b.handleContactCheck).Methods("POST")
	r.HandleFunc("/instances/{id}/contacts/info", b.handleContactInfo).Methods("POST")
	r.HandleFunc("/instances/{id}/contacts", b.handleContacts).Methods("GET")
	r.HandleFunc("/instances/{id}/contacts/block", b.handleContactBlock).Methods("POST")
	r.HandleFunc("/instances/{id}/chats/state", b.handleChatState).Methods("POST")
	r.HandleFunc("/instances/{id}/profile", b.handleProfile).Methods("GET")
	r.HandleFunc("/instances/{id}/profile/name", b.handleProfileName).Methods("POST")
	r.HandleFunc("/instances/{id}/profile/status", b.handleProfileStatus).Methods("POST")
	r.HandleFunc("/instances/{id}/profile/photo", b.handleProfilePhoto).Methods("POST")
	r.HandleFunc("/instances/{id}/groups", b.handleGroups).Methods("GET", "POST")
	r.HandleFunc("/instances/{id}/groups/info", b.handleGroupInfo).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/participants", b.handleGroupParticipants).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/name", b.handleGroupName).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/topic", b.handleGroupTopic).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/photo", b.handleGroupPhoto).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/invite", b.handleGroupInvite).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/join", b.handleGroupJoin).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/leave", b.handleGroupLeave).Methods("POST")
	r.HandleFunc("/instances/{id}/groups/settings", b.handleGroupSettings).Methods("POST")
}

func (b *Bridge) cacheMessage(instanceID int, message *events.Message) {
	if message == nil || message.Info.ID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.messages[instanceID] == nil {
		b.messages[instanceID] = make(map[string]*events.Message)
	}
	id := string(message.Info.ID)
	if _, exists := b.messages[instanceID][id]; !exists {
		b.messageIDs[instanceID] = append(b.messageIDs[instanceID], id)
	}
	b.messages[instanceID][id] = message
	for len(b.messageIDs[instanceID]) > receivedMessageCacheLimit {
		oldest := b.messageIDs[instanceID][0]
		b.messageIDs[instanceID] = b.messageIDs[instanceID][1:]
		delete(b.messages[instanceID], oldest)
	}
	if encoded, err := proto.Marshal(message.Message); err == nil {
		dir := filepath.Join(b.mediaCache, strconv.Itoa(instanceID))
		if os.MkdirAll(dir, 0750) == nil {
			_ = os.WriteFile(filepath.Join(dir, safeCacheID(id)+".pb"), encoded, 0640)
		}
	}
}

func safeCacheID(value string) string {
	var out strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_' {
			out.WriteRune(char)
		}
	}
	return out.String()
}

func (b *Bridge) advancedClient(w http.ResponseWriter, r *http.Request, req *advancedRequest) (*whatsmeow.Client, int, bool) {
	w.Header().Set("Content-Type", "application/json")
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return nil, 0, false
	}
	id, err := strconv.Atoi(mux.Vars(r)["id"])
	if err != nil {
		http.Error(w, "invalid instance id", http.StatusBadRequest)
		return nil, 0, false
	}
	if req != nil && r.Body != nil {
		if err = json.NewDecoder(r.Body).Decode(req); err != nil && err != io.EOF {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return nil, 0, false
		}
	}
	accountID := 0
	if req != nil {
		accountID = req.AccountID
	} else {
		accountID, _ = strconv.Atoi(r.URL.Query().Get("account_id"))
	}
	client, err := b.sendReadyClient(id, accountID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return nil, 0, false
	}
	return client, id, true
}

func advancedJID(client *whatsmeow.Client, req advancedRequest) (types.JID, error) {
	raw := strings.TrimSpace(req.JID)
	if raw == "" {
		raw = strings.TrimSpace(req.Number)
	}
	if raw == "" {
		return types.JID{}, fmt.Errorf("jid or number is required")
	}
	if !strings.Contains(raw, "@") {
		raw = onlyDigits(raw) + "@" + types.DefaultUserServer
	}
	target, err := types.ParseJID(raw)
	if err != nil || target.User == "" {
		return types.JID{}, fmt.Errorf("invalid jid")
	}
	if target.Server == types.DefaultUserServer || target.Server == types.LegacyUserServer {
		return (&Bridge{}).prepareRecipient(client, target.String())
	}
	return target, nil
}

func sendAdvanced(client *whatsmeow.Client, target types.JID, message *waProto.Message) (whatsmeow.SendResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	return sendWithPreWarm(client, ctx, target, message)
}

func (b *Bridge) handleSendLocation(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	resp, err := sendAdvanced(client, target, &waProto.Message{LocationMessage: &waProto.LocationMessage{
		DegreesLatitude: proto.Float64(req.Latitude), DegreesLongitude: proto.Float64(req.Longitude),
		Name: proto.String(req.Name), Address: proto.String(req.Address), URL: proto.String(req.URL),
	}})
	writeAdvancedResult(w, resp, err)
}

func buildVCard(name, phone, supplied string) string {
	if strings.TrimSpace(supplied) != "" {
		return supplied
	}
	number := "+" + onlyDigits(phone)
	return "BEGIN:VCARD\nVERSION:3.0\nFN:" + name + "\nTEL;TYPE=CELL:" + number + "\nEND:VCARD"
}

func (b *Bridge) handleSendContact(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	resp, err := sendAdvanced(client, target, &waProto.Message{ContactMessage: &waProto.ContactMessage{
		DisplayName: proto.String(req.Name), Vcard: proto.String(buildVCard(req.Name, req.Phone, req.VCard)),
	}})
	writeAdvancedResult(w, resp, err)
}

func (b *Bridge) handleSendReply(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, instanceID, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil || req.MessageID == "" {
		http.Error(w, "valid jid and message_id are required", 400)
		return
	}
	participant := req.Sender
	if participant == "" {
		participant = target.String()
	}
	quotedMessage := &waProto.Message{Conversation: proto.String(req.QuotedText)}
	b.mu.Lock()
	if cached := b.messages[instanceID][req.MessageID]; cached != nil && cached.Message != nil {
		quotedMessage = cached.Message
	}
	b.mu.Unlock()
	msg := &waProto.Message{ExtendedTextMessage: &waProto.ExtendedTextMessage{
		Text: proto.String(req.Text),
		ContextInfo: &waProto.ContextInfo{
			StanzaID: proto.String(req.MessageID), Participant: proto.String(participant),
			RemoteJID: proto.String(target.String()), QuotedMessage: quotedMessage,
		},
	}}
	resp, err := sendAdvanced(client, target, msg)
	writeAdvancedResult(w, resp, err)
}

func (b *Bridge) handleMessageReact(w http.ResponseWriter, r *http.Request) {
	b.handleBuiltMessage(w, r, func(client *whatsmeow.Client, target types.JID, req advancedRequest) *waProto.Message {
		return client.BuildReaction(target, parseSender(target, req.Sender), types.MessageID(req.MessageID), req.Reaction)
	})
}

func (b *Bridge) handleMessageEdit(w http.ResponseWriter, r *http.Request) {
	b.handleBuiltMessage(w, r, func(client *whatsmeow.Client, target types.JID, req advancedRequest) *waProto.Message {
		return client.BuildEdit(target, types.MessageID(req.MessageID), &waProto.Message{Conversation: proto.String(req.Text)})
	})
}

func (b *Bridge) handleMessageDelete(w http.ResponseWriter, r *http.Request) {
	b.handleBuiltMessage(w, r, func(client *whatsmeow.Client, target types.JID, req advancedRequest) *waProto.Message {
		return client.BuildRevoke(target, parseSender(target, req.Sender), types.MessageID(req.MessageID))
	})
}

func parseSender(fallback types.JID, raw string) types.JID {
	if jid, err := types.ParseJID(strings.TrimSpace(raw)); err == nil && jid.User != "" {
		return jid
	}
	return fallback
}

func (b *Bridge) handleBuiltMessage(w http.ResponseWriter, r *http.Request, build func(*whatsmeow.Client, types.JID, advancedRequest) *waProto.Message) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil || req.MessageID == "" {
		http.Error(w, "valid jid and message_id are required", 400)
		return
	}
	resp, err := sendAdvanced(client, target, build(client, target, req))
	writeAdvancedResult(w, resp, err)
}

func (b *Bridge) handleMessageRead(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil || req.MessageID == "" {
		http.Error(w, "valid jid and message_id are required", 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = client.MarkRead(ctx, []types.MessageID{types.MessageID(req.MessageID)}, time.Now(), target, parseSender(target, req.Sender))
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleMessageDownload(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, instanceID, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	b.mu.Lock()
	cached := b.messages[instanceID][req.MessageID]
	b.mu.Unlock()
	var message *waProto.Message
	if cached != nil {
		message = cached.Message
	}
	if message == nil {
		encoded, readErr := os.ReadFile(filepath.Join(b.mediaCache, strconv.Itoa(instanceID), safeCacheID(req.MessageID)+".pb"))
		if readErr == nil {
			message = &waProto.Message{}
			if unmarshalErr := proto.Unmarshal(encoded, message); unmarshalErr != nil {
				message = nil
			}
		}
	}
	if message == nil {
		http.Error(w, "message not found in media cache", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	data, err := client.DownloadAny(ctx, message)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+req.MessageID+`"`)
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Write(data)
}

func (b *Bridge) handlePresence(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var err error
	switch strings.ToLower(req.State) {
	case "available", "online":
		err = client.SendPresence(ctx, types.PresenceAvailable)
	case "unavailable", "offline":
		err = client.SendPresence(ctx, types.PresenceUnavailable)
	case "composing", "typing", "recording", "audio", "paused":
		target, targetErr := advancedJID(client, req)
		if targetErr != nil {
			err = targetErr
			break
		}
		presence := types.ChatPresenceComposing
		media := types.ChatPresenceMediaText
		if strings.EqualFold(req.State, "paused") {
			presence = types.ChatPresencePaused
		}
		if strings.EqualFold(req.State, "recording") || strings.EqualFold(req.State, "audio") {
			media = types.ChatPresenceMediaAudio
		}
		err = client.SendChatPresence(ctx, target, presence, media)
	default:
		err = fmt.Errorf("invalid presence state")
	}
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleContactCheck(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	number := req.Number
	if number == "" {
		number = req.JID
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := client.IsOnWhatsApp(ctx, phoneCandidates(number))
	writeAdvancedResult(w, result, err)
}

func (b *Bridge) handleContactInfo(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, instanceID, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = client.SendPresence(ctx, types.PresenceAvailable)
	_ = client.SubscribePresence(ctx, target)
	info, err := client.GetUserInfo(ctx, []types.JID{target})
	if err != nil {
		writeAdvancedResult(w, nil, err)
		return
	}
	contact, _ := client.Store.Contacts.GetContact(ctx, target)
	picture, _ := client.GetProfilePictureInfo(ctx, target, &whatsmeow.GetProfilePictureParams{Preview: true})
	time.Sleep(350 * time.Millisecond)
	b.mu.Lock()
	presence := b.presences[instanceID][target.ToNonAD().String()]
	b.mu.Unlock()
	writeAdvancedResult(w, map[string]interface{}{"jid": target, "info": info[target], "contact": contact, "picture": picture, "presence": presence}, nil)
}

func (b *Bridge) handleContacts(w http.ResponseWriter, r *http.Request) {
	client, _, ok := b.advancedClient(w, r, nil)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	contacts, err := client.Store.Contacts.GetAllContacts(ctx)
	writeAdvancedResult(w, contacts, err)
}

func (b *Bridge) handleContactBlock(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	action := events.BlocklistChangeActionBlock
	if strings.EqualFold(req.Action, "unblock") {
		action = events.BlocklistChangeActionUnblock
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	result, err := client.UpdateBlocklist(ctx, target, action)
	writeAdvancedResult(w, result, err)
}

func (b *Bridge) handleChatState(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	target, err := advancedJID(client, req)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	enabled := req.State != "false" && req.State != "off" && req.State != "0"
	switch strings.ToLower(req.Action) {
	case "archive":
		err = client.SendAppState(ctx, appstate.BuildArchive(target, enabled, time.Time{}, nil))
	case "pin":
		err = client.SendAppState(ctx, appstate.BuildPin(target, enabled))
	case "mute":
		duration := time.Duration(req.DurationSeconds) * time.Second
		err = client.SendAppState(ctx, appstate.BuildMute(target, enabled, duration))
	default:
		err = fmt.Errorf("action must be archive, pin or mute")
	}
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleProfile(w http.ResponseWriter, r *http.Request) {
	client, _, ok := b.advancedClient(w, r, nil)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	privacy := client.GetPrivacySettings(ctx)
	jid := client.Store.GetJID().ToNonAD()
	info, _ := client.GetUserInfo(ctx, []types.JID{jid})
	picture, _ := client.GetProfilePictureInfo(ctx, jid, &whatsmeow.GetProfilePictureParams{Preview: true})
	writeAdvancedResult(w, map[string]interface{}{
		"jid": jid, "pushName": client.Store.PushName, "businessName": client.Store.BusinessName,
		"isBusiness": client.Store.BusinessName != "", "privacy": privacy, "info": info[jid], "picture": picture,
	}, nil)
}

func (b *Bridge) handleProfileName(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := client.SendAppState(ctx, appstate.BuildSettingPushName(req.Name))
	if err == nil {
		client.Store.PushName = req.Name
		err = client.Store.Save(ctx)
	}
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleProfileStatus(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := client.SetStatusMessage(ctx, req.Text)
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleProfilePhoto(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	data, err := loadMediaBytes(req.Media)
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err = client.SetGroupPhoto(ctx, client.Store.GetJID().ToNonAD(), data)
	}
	writeAdvancedResult(w, map[string]bool{"success": err == nil}, err)
}

func (b *Bridge) handleGroups(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		client, _, ok := b.advancedClient(w, r, nil)
		if !ok {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		groups, err := client.GetJoinedGroups(ctx)
		writeAdvancedResult(w, groups, err)
		return
	}
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	participants, err := participantJIDs(client, req.Participants)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	group, err := client.CreateGroup(ctx, whatsmeow.ReqCreateGroup{Name: req.Name, Participants: participants})
	writeAdvancedResult(w, group, err)
}

func (b *Bridge) handleGroupInfo(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	group, err := groupJID(req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, err := client.GetGroupInfo(ctx, group)
	writeAdvancedResult(w, info, err)
}

func (b *Bridge) handleGroupParticipants(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	group, err := groupJID(req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	participants, err := participantJIDs(client, req.Participants)
	action := map[string]whatsmeow.ParticipantChange{
		"add": whatsmeow.ParticipantChangeAdd, "remove": whatsmeow.ParticipantChangeRemove,
		"promote": whatsmeow.ParticipantChangePromote, "demote": whatsmeow.ParticipantChangeDemote,
	}[strings.ToLower(req.Action)]
	if err != nil || action == "" {
		http.Error(w, "invalid participants or action", 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := client.UpdateGroupParticipants(ctx, group, participants, action)
	writeAdvancedResult(w, result, err)
}

func (b *Bridge) handleGroupName(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		return map[string]bool{"success": true}, client.SetGroupName(ctx, group, req.Name)
	})
}

func (b *Bridge) handleGroupTopic(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		return map[string]bool{"success": true}, client.SetGroupTopic(ctx, group, "", "", req.Topic)
	})
}

func (b *Bridge) handleGroupPhoto(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		data, err := loadMediaBytes(req.Media)
		if err != nil {
			return nil, err
		}
		return client.SetGroupPhoto(ctx, group, data)
	})
}

func (b *Bridge) handleGroupInvite(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		return client.GetGroupInviteLink(ctx, group, strings.EqualFold(req.Action, "reset"))
	})
}

func (b *Bridge) handleGroupJoin(w http.ResponseWriter, r *http.Request) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	code := strings.TrimPrefix(strings.TrimSpace(req.Code), whatsmeow.InviteLinkPrefix)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	jid, err := client.JoinGroupWithLink(ctx, code)
	writeAdvancedResult(w, jid, err)
}

func (b *Bridge) handleGroupLeave(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		return map[string]bool{"success": true}, client.LeaveGroup(ctx, group)
	})
}

func (b *Bridge) handleGroupSettings(w http.ResponseWriter, r *http.Request) {
	b.handleGroupSimple(w, r, func(ctx context.Context, client *whatsmeow.Client, group types.JID, req advancedRequest) (interface{}, error) {
		if req.Locked != nil {
			if err := client.SetGroupLocked(ctx, group, *req.Locked); err != nil {
				return nil, err
			}
		}
		if req.Announce != nil {
			if err := client.SetGroupAnnounce(ctx, group, *req.Announce); err != nil {
				return nil, err
			}
		}
		return map[string]bool{"success": true}, nil
	})
}

func (b *Bridge) handleGroupSimple(w http.ResponseWriter, r *http.Request, action func(context.Context, *whatsmeow.Client, types.JID, advancedRequest) (interface{}, error)) {
	var req advancedRequest
	client, _, ok := b.advancedClient(w, r, &req)
	if !ok {
		return
	}
	group, err := groupJID(req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := action(ctx, client, group, req)
	writeAdvancedResult(w, result, err)
}

func groupJID(raw string) (types.JID, error) {
	jid, err := types.ParseJID(strings.TrimSpace(raw))
	if err != nil || jid.Server != types.GroupServer {
		return types.JID{}, fmt.Errorf("valid group jid is required")
	}
	return jid, nil
}

func participantJIDs(client *whatsmeow.Client, values []string) ([]types.JID, error) {
	result := make([]types.JID, 0, len(values))
	for _, value := range values {
		req := advancedRequest{JID: value}
		jid, err := advancedJID(client, req)
		if err != nil {
			return nil, err
		}
		result = append(result, jid)
	}
	return result, nil
}

func loadMediaBytes(source string) ([]byte, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return nil, nil
	}
	if strings.HasPrefix(source, "data:") {
		if comma := strings.Index(source, ","); comma >= 0 {
			source = source[comma+1:]
		}
	}
	if decoded, err := base64.StdEncoding.DecodeString(source); err == nil {
		return decoded, nil
	}
	if strings.HasPrefix(source, "https://") {
		if err := isSafeURL(source); err != nil {
			return nil, err
		}
		resp, err := httpClient.Get(source)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("media download returned status %d", resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 15<<20))
	}
	return nil, fmt.Errorf("media must be a base64 data URI or HTTPS URL")
}

func writeAdvancedResult(w http.ResponseWriter, value interface{}, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "result": value})
}
