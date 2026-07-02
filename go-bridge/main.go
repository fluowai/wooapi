package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	waCompanionReg "go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

type Bridge struct {
	container  *sqlstore.Container
	db         *sql.DB
	clients    map[int]*whatsmeow.Client
	connecting map[int]bool
	lastQR     map[int]string
	messages   map[int]map[string]*events.Message
	messageIDs map[int][]string
	mediaCache string
	presences  map[int]map[string]map[string]interface{}
	mu         sync.Mutex
	nodeURL    string
	token      string
	logLevel   string
}

func NewBridge() *Bridge {
	deviceName := envOrDefault("BRIDGE_DEVICE_NAME", "Wozapi")
	store.SetOSInfo(deviceName, [3]uint32{1, 0, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.DeviceProps.Os = proto.String(deviceName)
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	store.BaseClientPayload.UserAgent.Manufacturer = proto.String(deviceName)
	store.BaseClientPayload.UserAgent.Device = proto.String(deviceName)
	store.BaseClientPayload.UserAgent.OsVersion = proto.String("1.0")
	_ = os.Setenv("WHATSMEOW_DEVICE_NAME", deviceName)

	logLevel := envOrDefault("BRIDGE_LOG_LEVEL", "INFO")
	dbLog := waLog.Stdout("Database", "ERROR", true)

	databaseURL := os.Getenv("DATABASE_URL")
	var driverName string
	var dsn string
	if databaseURL != "" {
		driverName = "pgx"
		dsn = preparePostgresDSN(databaseURL)
	} else {
		driverName = "sqlite"
		dbPath := envOrDefault("BRIDGE_DB_PATH", "wooapi_bridge.db")
		dsn = fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(15000)&_pragma=journal_mode(WAL)", dbPath)
	}

	container, err := sqlstore.New(context.Background(), driverName, dsn, dbLog)
	if err != nil {
		panic(err)
	}
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		panic(err)
	}
	if driverName == "sqlite" {
		if _, err = db.Exec(`
			CREATE TABLE IF NOT EXISTS wooapi_instance_devices (
				instance_id INTEGER PRIMARY KEY,
				jid TEXT NOT NULL,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)
		`); err != nil {
			panic(err)
		}
	} else {
		if _, err = db.Exec(`
			CREATE TABLE IF NOT EXISTS wooapi_instance_devices (
				instance_id INTEGER PRIMARY KEY,
				jid TEXT NOT NULL,
				updated_at TIMESTAMPTZ DEFAULT NOW()
			)
		`); err != nil {
			panic(err)
		}
	}

	mediaCache := envOrDefault("BRIDGE_MEDIA_CACHE_DIR", "media-cache")
	_ = os.MkdirAll(mediaCache, 0750)

	return &Bridge{
		container:  container,
		db:         db,
		clients:    make(map[int]*whatsmeow.Client),
		connecting: make(map[int]bool),
		lastQR:     make(map[int]string),
		messages:   make(map[int]map[string]*events.Message),
		messageIDs: make(map[int][]string),
		mediaCache: mediaCache,
		presences:  make(map[int]map[string]map[string]interface{}),
		nodeURL:    envOrDefault("NODE_URL", "http://localhost:3000"),
		token:      envOrDefault("BRIDGE_TOKEN", "dev-bridge-token"),
		logLevel:   logLevel,
	}
}

func envOrDefault(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func preparePostgresDSN(dsn string) string {
	parsed, err := url.Parse(dsn)
	if err != nil {
		return dsn
	}
	query := parsed.Query()
	if query.Get("default_query_exec_mode") == "" {
		query.Set("default_query_exec_mode", "simple_protocol")
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (b *Bridge) sendToNode(event string, instanceId int, accountId int, payload interface{}) {
	data := map[string]interface{}{
		"event":      event,
		"instanceId": instanceId,
		"accountId":  accountId,
		"payload":    payload,
	}
	body, _ := json.Marshal(data)
	req, err := http.NewRequest("POST", b.nodeURL+"/api/bridge/event", bytes.NewBuffer(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bridge-Token", b.token)
	resp, err := httpClient.Do(req)
	if err == nil && resp != nil {
		resp.Body.Close()
	}
}

func (b *Bridge) eventHandler(instanceId int, accountId int, evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		b.cacheMessage(instanceId, v)
		enriched := b.enrichMessage(v, instanceId)
		b.sendToNode("message", instanceId, accountId, enriched)
	case *events.Receipt:
		b.sendToNode("receipt", instanceId, accountId, v)
	case *events.Presence:
		b.mu.Lock()
		if b.presences[instanceId] == nil {
			b.presences[instanceId] = make(map[string]map[string]interface{})
		}
		presence := map[string]interface{}{
			"jid":         v.From.String(),
			"available":   !v.Unavailable,
			"unavailable": v.Unavailable,
			"updatedAt":   time.Now().UTC(),
		}
		if !v.LastSeen.IsZero() {
			presence["lastSeen"] = v.LastSeen.UTC()
		}
		b.presences[instanceId][v.From.ToNonAD().String()] = presence
		b.mu.Unlock()
		b.sendToNode("presence", instanceId, accountId, presence)
	case *events.PairSuccess:
		b.mu.Lock()
		client, ok := b.clients[instanceId]
		delete(b.lastQR, instanceId)
		b.connecting[instanceId] = false
		b.mu.Unlock()
		b.bindInstanceDevice(instanceId, v.ID)
		if ok {
			payload := b.statusPayload(client, "open")
			jid := v.ID.ToNonAD()
			if jid.User != "" {
				payload["jid"] = jid.String()
				payload["phoneConnected"] = jid.User
				payload["phone_connected"] = jid.User
			}
			if v.BusinessName != "" {
				payload["profileName"] = v.BusinessName
				payload["profile_name"] = v.BusinessName
			}
			b.sendToNode("status", instanceId, accountId, payload)
		}
	case *events.Connected:
		b.mu.Lock()
		b.connecting[instanceId] = false
		client, ok := b.clients[instanceId]
		b.mu.Unlock()
		if ok {
			if client.Store != nil && client.Store.ID != nil {
				b.bindInstanceDevice(instanceId, *client.Store.ID)
			}
			status := "open"
			if !client.IsLoggedIn() {
				status = "qr"
			}
			b.sendToNode("status", instanceId, accountId, b.statusPayload(client, status))
			go func() {
				time.Sleep(2 * time.Second)
				b.sendToNode("status", instanceId, accountId, b.statusPayload(client, status))
			}()
		} else {
			b.sendToNode("status", instanceId, accountId, map[string]string{"status": "open"})
		}
	case *events.Disconnected:
		b.mu.Lock()
		b.connecting[instanceId] = false
		b.mu.Unlock()
		b.sendToNode("status", instanceId, accountId, map[string]string{"status": "close"})
	case *events.LoggedOut:
		b.mu.Lock()
		b.connecting[instanceId] = false
		delete(b.clients, instanceId)
		delete(b.lastQR, instanceId)
		b.mu.Unlock()
		b.sendToNode("status", instanceId, accountId, map[string]string{"status": "none"})
	case *events.LabelEdit:
		b.sendToNode("label_edit", instanceId, accountId, map[string]interface{}{
			"labelId":   v.LabelID,
			"labelName": v.Action.GetName(),
			"labelColor": v.Action.GetColor(),
			"deleted":   v.Action.GetDeleted(),
			"timestamp": v.Timestamp,
		})
	case *events.LabelAssociationChat:
		b.sendToNode("label_association_chat", instanceId, accountId, map[string]interface{}{
			"jid":       v.JID.String(),
			"labelId":   v.LabelID,
			"labeled":   v.Action.GetLabeled(),
			"timestamp": v.Timestamp,
		})
	case *events.LabelAssociationMessage:
		b.sendToNode("label_association_message", instanceId, accountId, map[string]interface{}{
			"jid":       v.JID.String(),
			"labelId":   v.LabelID,
			"messageId": v.MessageID,
			"labeled":   v.Action.GetLabeled(),
			"timestamp": v.Timestamp,
		})
	}
}

func (b *Bridge) statusPayload(client *whatsmeow.Client, status string) map[string]string {
	payload := map[string]string{"status": status}
	var ownJID types.JID
	if client != nil && client.Store != nil {
		if client.Store.ID != nil {
			ownJID = client.Store.ID.ToNonAD()
		}
		if ownJID.User != "" {
			payload["jid"] = ownJID.String()
			payload["phoneConnected"] = ownJID.User
			payload["phone_connected"] = ownJID.User
		}
		if client.Store.PushName != "" {
			payload["profileName"] = client.Store.PushName
			payload["profile_name"] = client.Store.PushName
		} else if client.Store.BusinessName != "" {
			payload["profileName"] = client.Store.BusinessName
			payload["profile_name"] = client.Store.BusinessName
		}
	}
	if client != nil && client.Store != nil && ownJID.User != "" && client.IsConnected() {
		if pictureURL := b.safeProfilePictureURL(client, ownJID); pictureURL != "" {
			payload["profilePictureUrl"] = pictureURL
			payload["profile_picture_url"] = pictureURL
		}
	}
	return payload
}

func (b *Bridge) safeProfilePictureURL(client *whatsmeow.Client, jid types.JID) (url string) {
	defer func() {
		if recover() != nil {
			url = ""
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pic, err := client.GetProfilePictureInfo(ctx, jid, &whatsmeow.GetProfilePictureParams{Preview: true})
	if err != nil || pic == nil {
		return ""
	}
	return pic.URL
}

// formatBrazilianNumber formata um número brasileiro: 5548988003260 -> +55 (48) 98800-3260
func formatBrazilianNumber(user string) string {
	digits := onlyDigits(user)
	if len(digits) < 10 {
		return digits
	}
	hasCountryCode := strings.HasPrefix(digits, "55")
	if hasCountryCode {
		digits = digits[2:]
	}
	if len(digits) == 10 {
		// 48 8800 3260
		return fmt.Sprintf("+55 (%s) %s-%s", digits[:2], digits[2:6], digits[6:])
	} else if len(digits) == 11 {
		// 48 9 8800 3260
		return fmt.Sprintf("+55 (%s) %s%s-%s", digits[:2], string(digits[2]), digits[3:7], digits[7:])
	}
	return "+55" + digits
}

// enrichMessage enriquece o payload da mensagem com informações adicionais
// antes de enviá-la para o Node: groupName, pushName resolvido, número formatado
func (b *Bridge) enrichMessage(msg *events.Message, instanceID int) map[string]interface{} {
	out := make(map[string]interface{})
	raw, _ := json.Marshal(msg)
	json.Unmarshal(raw, &out)

	// Garante que Info esteja em ambos os formatos (maiúsculo e minúsculo)
	info, _ := out["Info"].(map[string]interface{})
	if info == nil {
		info, _ = out["info"].(map[string]interface{})
	}
	if info == nil {
		info = make(map[string]interface{})
		out["Info"] = info
		out["info"] = info
	}

	chatJID := msg.Info.Chat
	senderJID := msg.Info.Sender
	isGroup := chatJID.Server == types.GroupServer

	// Resolve LID → phone number if sender is a LID JID
	if senderJID.Server == types.HiddenUserServer {
		client := b.clients[instanceID]
		if client != nil && client.Store != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			phoneJID, err := client.Store.LIDs.GetPNForLID(ctx, senderJID)
			cancel()
			if err == nil && phoneJID.User != "" {
				info["LID"] = senderJID.User
				info["lid"] = senderJID.User
				info["ResolvedPhone"] = phoneJID.User
				info["resolvedPhone"] = phoneJID.User
				// Ensure raw_sender_jid is populated
				info["SenderJID"] = senderJID.String()
				info["senderJID"] = senderJID.String()
			}
		}
	}

	// 1. Resolve nome do grupo
	if isGroup {
		b.mu.Lock()
		client, hasClient := b.clients[instanceID]
		b.mu.Unlock()
		if hasClient && client != nil && client.IsLoggedIn() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			groupInfo, err := client.GetGroupInfo(ctx, chatJID)
			cancel()
			if err == nil && groupInfo.Name != "" {
				info["GroupName"] = groupInfo.Name
				info["groupName"] = groupInfo.Name
				info["ChatName"] = groupInfo.Name
				info["chatName"] = groupInfo.Name
				out["GroupName"] = groupInfo.Name
				out["groupName"] = groupInfo.Name
			}
		}
	}

	// 2. Resolve push name do remetente
	pushName, _ := info["PushName"].(string)
	if pushName == "" {
		pushName, _ = info["pushName"].(string)
	}
	if pushName == "" && senderJID.User != "" {
		b.mu.Lock()
		client, hasClient := b.clients[instanceID]
		b.mu.Unlock()
		if hasClient && client != nil && client.IsLoggedIn() && client.Store != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			contact, err := client.Store.Contacts.GetContact(ctx, senderJID.ToNonAD())
			cancel()
			if err == nil && contact.PushName != "" {
				pushName = contact.PushName
				info["PushName"] = pushName
				info["pushName"] = pushName
			}
		}
	}

	// 3. Adiciona número formatado do remetente (usa telefone resolvido se for LID)
	phoneForDisplay := senderJID.User
	if resolvedPhone, ok := info["resolvedPhone"].(string); ok && resolvedPhone != "" {
		phoneForDisplay = resolvedPhone
	}
	if phoneForDisplay != "" {
		formatted := formatBrazilianNumber(phoneForDisplay)
		info["FormattedNumber"] = formatted
		info["formattedNumber"] = formatted
		out["FormattedNumber"] = formatted
		out["formattedNumber"] = formatted
	}

	// 4. Resolve push names de menções
	if msg.Message != nil && msg.Message.ExtendedTextMessage != nil && len(msg.Message.ExtendedTextMessage.ContextInfo.GetMentionedJID()) > 0 {
		mentions := make([]map[string]interface{}, 0)
		mentionJIDs := msg.Message.ExtendedTextMessage.ContextInfo.GetMentionedJID()
		for _, mJID := range mentionJIDs {
			parsed, err := types.ParseJID(mJID)
			if err != nil || parsed.User == "" {
				continue
			}
			entry := map[string]interface{}{
				"jid":             parsed.ToNonAD().String(),
				"pushName":        "",
				"formattedNumber": formatBrazilianNumber(parsed.User),
			}
			b.mu.Lock()
			client, hasClient := b.clients[instanceID]
			b.mu.Unlock()
			if hasClient && client != nil && client.IsLoggedIn() && client.Store != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				contact, err := client.Store.Contacts.GetContact(ctx, parsed.ToNonAD())
				cancel()
				if err == nil && contact.PushName != "" {
					entry["pushName"] = contact.PushName
				}
			}
			mentions = append(mentions, entry)
		}
		if len(mentions) > 0 {
			info["MentionedContacts"] = mentions
			info["mentionedContacts"] = mentions
		}
	}

	return out
}

func (b *Bridge) bindInstanceDevice(instanceID int, jid types.JID) {
	if instanceID <= 0 || jid.User == "" || b.db == nil {
		return
	}
	_, _ = b.db.Exec(
		"INSERT INTO wooapi_instance_devices (instance_id, jid, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(instance_id) DO UPDATE SET jid = excluded.jid, updated_at = CURRENT_TIMESTAMP",
		instanceID,
		jid.String(),
	)
}

func (b *Bridge) unbindInstanceDevice(instanceID int) {
	if instanceID <= 0 || b.db == nil {
		return
	}
	_, _ = b.db.Exec("DELETE FROM wooapi_instance_devices WHERE instance_id = ?", instanceID)
}

func (b *Bridge) boundDeviceJID(instanceID int) string {
	if instanceID <= 0 || b.db == nil {
		return ""
	}
	var jid string
	if err := b.db.QueryRow("SELECT jid FROM wooapi_instance_devices WHERE instance_id = ?", instanceID).Scan(&jid); err != nil {
		return ""
	}
	return strings.TrimSpace(jid)
}

func (b *Bridge) getStoredDevice(ctx context.Context, instanceID int, requestedJID string) (*store.Device, error) {
	requestedJID = strings.TrimSpace(requestedJID)
	if requestedJID == "" {
		requestedJID = b.boundDeviceJID(instanceID)
	}
	devices, err := b.container.GetAllDevices(ctx)
	if err != nil {
		return nil, err
	}
	if requestedJID == "" {
		return nil, nil
	}
	parsedJID, err := types.ParseJID(requestedJID)
	if err != nil || parsedJID.User == "" {
		return nil, nil
	}
	requestedNonAD := parsedJID.ToNonAD()
	for _, device := range devices {
		if device != nil && device.ID != nil && device.ID.ToNonAD() == requestedNonAD {
			b.bindInstanceDevice(instanceID, *device.ID)
			return device, nil
		}
	}
	return nil, nil
}

func (b *Bridge) ensureUsableClient(instanceID int, accountID int, requestedJID string) (*whatsmeow.Client, error) {
	deadline := time.Now().Add(12 * time.Second)
	for {
		b.mu.Lock()
		connecting := b.connecting[instanceID]
		client, ok := b.clients[instanceID]
		b.mu.Unlock()
		if !connecting {
			if ok {
				if client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
					return client, nil
				}
				client.Disconnect()
				b.mu.Lock()
				if b.clients[instanceID] == client {
					delete(b.clients, instanceID)
				}
				b.connecting[instanceID] = false
				b.mu.Unlock()
			}
			break
		}
		if ok && client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
			return client, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("instance is still connecting")
		}
		time.Sleep(300 * time.Millisecond)
	}

	b.mu.Lock()
	if b.connecting[instanceID] {
		b.mu.Unlock()
		return nil, fmt.Errorf("instance is still connecting")
	}
	if client, ok := b.clients[instanceID]; ok {
		if client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
			b.mu.Unlock()
			return client, nil
		}
		client.Disconnect()
		delete(b.clients, instanceID)
		b.connecting[instanceID] = false
	}
	b.connecting[instanceID] = true
	b.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	deviceStore, err := b.getStoredDevice(ctx, instanceID, requestedJID)
	if err != nil {
		b.mu.Lock()
		b.connecting[instanceID] = false
		b.mu.Unlock()
		return nil, err
	}
	if deviceStore == nil || deviceStore.ID == nil {
		b.mu.Lock()
		b.connecting[instanceID] = false
		b.mu.Unlock()
		return nil, fmt.Errorf("paired device not found")
	}

	clientLog := waLog.Stdout("Client", b.logLevel, true)
	client := whatsmeow.NewClient(deviceStore, clientLog)
	b.mu.Lock()
	b.clients[instanceID] = client
	b.mu.Unlock()
	client.AddEventHandler(func(evt interface{}) {
		b.eventHandler(instanceID, accountID, evt)
	})

	if err := client.Connect(); err != nil {
		b.mu.Lock()
		b.connecting[instanceID] = false
		if b.clients[instanceID] == client {
			delete(b.clients, instanceID)
		}
		b.mu.Unlock()
		return nil, err
	}
	client.WaitForConnection(8 * time.Second)
	b.mu.Lock()
	b.connecting[instanceID] = false
	b.mu.Unlock()
	if !client.IsConnected() {
		return nil, fmt.Errorf("client not connected")
	}
	if client.Store == nil || client.Store.GetJID().User == "" {
		return nil, fmt.Errorf("the store doesn't contain a device JID")
	}
	return client, nil
}

func (b *Bridge) sendReadyClient(instanceID int, accountID int) (*whatsmeow.Client, error) {
	client, err := b.ensureUsableClient(instanceID, accountID, "")
	if err != nil {
		return nil, err
	}
	if client.Store == nil || client.Store.GetJID().User == "" {
		return nil, fmt.Errorf("the store doesn't contain a device JID")
	}
	return client, nil
}

func (b *Bridge) prepareRecipient(client *whatsmeow.Client, jidText string) (types.JID, error) {
	targetJid, err := types.ParseJID(strings.TrimSpace(jidText))
	if err != nil || targetJid.User == "" {
		return types.JID{}, fmt.Errorf("invalid jid")
	}
	if targetJid.Server == types.LegacyUserServer || targetJid.Server == types.DefaultUserServer {
		candidates := phoneCandidates(targetJid.User)
		if len(candidates) == 0 {
			return targetJid, nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		resp, err := client.IsOnWhatsApp(ctx, candidates)
		if err != nil {
			return types.JID{}, fmt.Errorf("failed to validate recipient: %w", err)
		}
		for _, candidate := range candidates {
			normalized := strings.TrimPrefix(candidate, "+")
			for _, item := range resp {
				if item.IsIn && strings.TrimPrefix(item.Query, "+") == normalized && item.JID.User != "" {
					// Tenta resolver para LID (Linked ID) se disponível
					lidCtx, lidCancel := context.WithTimeout(context.Background(), 3*time.Second)
					lidJID, err := client.Store.LIDs.GetLIDForPN(lidCtx, item.JID)
					lidCancel()
					if err == nil && lidJID.User != "" {
						return lidJID, nil
					}
					return item.JID, nil
				}
			}
		}
		return types.JID{}, fmt.Errorf("recipient is not registered on WhatsApp")
	}
	return targetJid, nil
}

func (b *Bridge) recipientDiagnostics(client *whatsmeow.Client, jidText string) (map[string]interface{}, error) {
	targetJid, err := types.ParseJID(strings.TrimSpace(jidText))
	if err != nil || targetJid.User == "" {
		return nil, fmt.Errorf("invalid jid")
	}
	out := map[string]interface{}{
		"inputJid": targetJid.String(),
		"server":   targetJid.Server,
	}
	if targetJid.Server != types.LegacyUserServer && targetJid.Server != types.DefaultUserServer {
		return out, nil
	}
	candidates := phoneCandidates(targetJid.User)
	out["candidates"] = candidates
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, err := client.IsOnWhatsApp(ctx, candidates)
	if err != nil {
		return nil, fmt.Errorf("failed to validate recipient: %w", err)
	}
	items := make([]map[string]interface{}, 0, len(resp))
	for _, item := range resp {
		entry := map[string]interface{}{
			"query":        item.Query,
			"isIn":         item.IsIn,
			"jid":          item.JID.String(),
			"verifiedName": "",
		}
		if item.VerifiedName != nil {
			entry["verifiedName"] = item.VerifiedName.Details.GetVerifiedName()
		}
		if item.IsIn && item.JID.User != "" && client.Store != nil {
			if lid, lidErr := client.Store.LIDs.GetLIDForPN(ctx, item.JID); lidErr == nil && lid.User != "" {
				entry["lid"] = lid.String()
			}
			if info, infoErr := client.GetUserInfo(ctx, []types.JID{item.JID}); infoErr == nil {
				if userInfo, ok := info[item.JID]; ok {
					entry["userInfoLid"] = userInfo.LID.String()
					entry["devices"] = len(userInfo.Devices)
					entry["status"] = userInfo.Status
				}
			}
		}
		items = append(items, entry)
	}
	out["results"] = items
	return out, nil
}

func phoneCandidates(user string) []string {
	digits := onlyDigits(user)
	if digits == "" {
		return nil
	}
	candidates := []string{"+" + digits}
	if strings.HasPrefix(digits, "55") && len(digits) == 13 {
		withoutNinth := digits[:4] + digits[5:]
		if withoutNinth != digits {
			candidates = append(candidates, "+"+withoutNinth)
		}
	} else if strings.HasPrefix(digits, "55") && len(digits) == 12 {
		withNinth := digits[:4] + "9" + digits[4:]
		if withNinth != digits {
			candidates = append(candidates, "+"+withNinth)
		}
	}
	return candidates
}

func onlyDigits(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func isReachoutTimelockError(err error) bool {
	return err != nil &&
		errors.Is(err, whatsmeow.ErrServerReturnedError) &&
		strings.HasSuffix(err.Error(), " 463")
}

func sendWithPreWarm(client *whatsmeow.Client, ctx context.Context, target types.JID, msg *waProto.Message) (whatsmeow.SendResponse, error) {
	isUserJID := target.Server == types.DefaultUserServer || target.Server == types.LegacyUserServer || target.Server == types.HiddenUserServer
	if isUserJID {
		preWarmCtx, preWarmCancel := context.WithTimeout(context.Background(), 3*time.Second)
		client.SubscribePresence(preWarmCtx, target)
		preWarmCancel()
	}
	resp, err := client.SendMessage(ctx, target, msg)
	if err != nil && isReachoutTimelockError(err) && isUserJID {
		fmt.Printf("[WARN] Error 463 on send to %s, retrying once after SubscribePresence\n", target)
		preWarmCtx, preWarmCancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = client.SubscribePresence(preWarmCtx, target)
		preWarmCancel()
		time.Sleep(500 * time.Millisecond)
		resp, err = client.SendMessage(ctx, target, msg)
		if err != nil {
			err = fmt.Errorf("%w: envio rejeitado (erro 463). O contato precisa enviar mensagem primeiro ou a conta pode estar restrita. Peça para o contato enviar uma mensagem para este número.", err)
		}
	}
	return resp, err
}

func (b *Bridge) checkAccountRestriction(client *whatsmeow.Client) map[string]interface{} {
	result := map[string]interface{}{
		"connected": client.IsConnected(),
		"loggedIn":  client.IsLoggedIn(),
	}
	if client.Store != nil {
		result["jid"] = client.Store.GetJID().ToNonAD().String()
		result["pushName"] = client.Store.PushName
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info, err := client.GetUserInfo(ctx, []types.JID{client.Store.GetJID().ToNonAD()})
	if err == nil {
		ownJID := client.Store.GetJID().ToNonAD()
		if userInfo, ok := info[ownJID]; ok {
			result["devices"] = len(userInfo.Devices)
			result["status"] = userInfo.Status
		}
	}
	return result
}

func (b *Bridge) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	accountID, _ := strconv.Atoi(r.URL.Query().Get("account_id"))

	b.mu.Lock()
	client, ok := b.clients[id]
	connecting := b.connecting[id]
	lastQR := b.lastQR[id]
	b.mu.Unlock()
	if !ok {
		if connecting {
			resp := map[string]string{"status": "connecting"}
			if lastQR != "" {
				resp["status"] = "qr"
				resp["qr"] = lastQR
			}
			json.NewEncoder(w).Encode(resp)
			return
		}
		restoredClient, err := b.ensureUsableClient(id, accountID, "")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]string{"status": "none"})
			return
		}
		client = restoredClient
		ok = true
	}

	status := "close"
	if client.IsLoggedIn() {
		status = "open"
	} else if client.IsConnected() {
		status = "qr"
	} else if connecting {
		status = "connecting"
	}
	payload := b.statusPayload(client, status)
	if status == "qr" && lastQR != "" {
		payload["qr"] = lastQR
	}
	json.NewEncoder(w).Encode(payload)
}

func (b *Bridge) handleConnect(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId  int    `json:"account_id"`
		JID        string `json:"jid"`
		ForceNewQR bool   `json:"force_new_qr"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	requestedJID := strings.TrimSpace(req.JID)

	b.mu.Lock()
	if b.connecting[id] && !req.ForceNewQR {
		lastQR := b.lastQR[id]
		b.mu.Unlock()
		resp := map[string]string{"status": "connecting"}
		if lastQR != "" {
			resp["status"] = "qr"
			resp["qr"] = lastQR
		}
		json.NewEncoder(w).Encode(resp)
		return
	}
	if client, ok := b.clients[id]; ok {
		if !req.ForceNewQR && client.IsLoggedIn() && client.Store != nil && client.Store.ID != nil {
			b.bindInstanceDevice(id, *client.Store.ID)
			payload := b.statusPayload(client, "open")
			b.mu.Unlock()
			json.NewEncoder(w).Encode(payload)
			return
		}
		b.mu.Unlock()
		client.Disconnect()
		if req.ForceNewQR && client.Store != nil {
			_ = client.Store.Delete(context.Background())
			b.unbindInstanceDevice(id)
		}
		b.mu.Lock()
		if b.clients[id] == client {
			delete(b.clients, id)
		}
		b.connecting[id] = false
		if req.ForceNewQR {
			delete(b.lastQR, id)
		}
		b.mu.Unlock()
	} else {
		if req.ForceNewQR {
			delete(b.lastQR, id)
			b.unbindInstanceDevice(id)
		}
		b.mu.Unlock()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deviceStore, err := b.getStoredDevice(ctx, id, requestedJID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	if deviceStore == nil {
		deviceStore = b.container.NewDevice()
	}

	clientLog := waLog.Stdout("Client", b.logLevel, true)
	client := whatsmeow.NewClient(deviceStore, clientLog)
	b.mu.Lock()
	b.clients[id] = client
	b.connecting[id] = true
	b.mu.Unlock()

	client.AddEventHandler(func(evt interface{}) {
		b.eventHandler(id, req.AccountId, evt)
	})

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(context.Background())
		firstPairingState := make(chan map[string]interface{}, 1)
		err = client.Connect()
		if err != nil {
			b.mu.Lock()
			b.connecting[id] = false
			if b.clients[id] == client {
				delete(b.clients, id)
			}
			b.mu.Unlock()
			http.Error(w, err.Error(), 500)
			return
		}

		go func() {
			for evt := range qrChan {
				switch evt.Event {
				case whatsmeow.QRChannelEventCode:
					fmt.Printf("[QR] Instance %d: %s\n", id, evt.Code)
					b.mu.Lock()
					b.lastQR[id] = evt.Code
					b.mu.Unlock()
					select {
					case firstPairingState <- map[string]interface{}{"status": "qr", "qr": evt.Code}:
					default:
					}
					b.sendToNode("qr", id, req.AccountId, map[string]string{"qr": evt.Code})
					qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				case whatsmeow.QRChannelEventPasskeyRequest:
					payload := map[string]interface{}{
						"status":    "passkey_required",
						"publicKey": evt.PasskeyRequest.PublicKey,
					}
					select {
					case firstPairingState <- payload:
					default:
					}
					b.sendToNode("passkey_required", id, req.AccountId, payload)
				case whatsmeow.QRChannelEventPasskeyResponse:
					b.sendToNode("passkey_confirmation", id, req.AccountId, map[string]interface{}{
						"status":        "passkey_confirmation",
						"code":          evt.PasskeyConfirmation.Code,
						"skipHandoffUX": evt.PasskeyConfirmation.SkipHandoffUX,
					})
				case whatsmeow.QRChannelEventError:
					errMsg := ""
					if evt.Error != nil {
						errMsg = evt.Error.Error()
					}
					b.sendToNode("passkey_error", id, req.AccountId, map[string]interface{}{"status": "passkey_error", "error": errMsg})
				}
			}
		}()
		select {
		case payload := <-firstPairingState:
			json.NewEncoder(w).Encode(payload)
			return
		case <-time.After(20 * time.Second):
			json.NewEncoder(w).Encode(map[string]string{"status": "connecting"})
			return
		}
	}

	err = client.Connect()
	if err != nil {
		b.mu.Lock()
		b.connecting[id] = false
		if b.clients[id] == client {
			delete(b.clients, id)
		}
		b.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "connecting"})
}

func (b *Bridge) handleSend(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId  int    `json:"account_id"`
		JID        string `json:"jid"`
		ForceNewQR bool   `json:"force_new_qr"`
		Text       string `json:"text"`
	}
	json.NewDecoder(r.Body).Decode(&req)
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
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	resp, err := sendWithPreWarm(client, ctx, targetJid, &waProto.Message{
		Conversation: proto.String(req.Text),
	})

	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (b *Bridge) handleCheckRecipient(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	var req struct {
		AccountId int    `json:"account_id"`
		JID       string `json:"jid"`
		Number    string `json:"number"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	jid := strings.TrimSpace(req.JID)
	if jid == "" && strings.TrimSpace(req.Number) != "" {
		jid = onlyDigits(req.Number) + "@" + types.LegacyUserServer
	}
	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	result, err := b.recipientDiagnostics(client, jid)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	json.NewEncoder(w).Encode(result)
}

type interactiveButtonRequest struct {
	ID          string `json:"id"`
	ButtonID    string `json:"buttonId"`
	Text        string `json:"text"`
	DisplayText string `json:"displayText"`
	URL         string `json:"url"`
	Link        string `json:"link"`
	Href        string `json:"href"`
}

type interactiveRowRequest struct {
	ID          string `json:"id"`
	RowID       string `json:"rowId"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type interactiveSectionRequest struct {
	Title string                  `json:"title"`
	Rows  []interactiveRowRequest `json:"rows"`
}

func (b *Bridge) handleSendButtons(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId int                        `json:"account_id"`
		JID       string                     `json:"jid"`
		Title     string                     `json:"title"`
		Text      string                     `json:"text"`
		Body      string                     `json:"body"`
		Footer    string                     `json:"footer"`
		Buttons   []interactiveButtonRequest `json:"buttons"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	content := strings.TrimSpace(req.Text)
	if content == "" {
		content = strings.TrimSpace(req.Body)
	}
	if req.JID == "" || content == "" || len(req.Buttons) == 0 {
		http.Error(w, "jid, text and buttons are required", 400)
		return
	}
	if len(req.Buttons) > 3 {
		http.Error(w, "buttons supports up to 3 options", 400)
		return
	}
	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	// Build quick_reply buttons using InteractiveMessage (NativeFlowMessage v3).
	// The legacy ButtonsMessage proto was silently blocked by WhatsApp in 2023.
	nativeButtons := make([]*waProto.InteractiveMessage_NativeFlowMessage_NativeFlowButton, 0, len(req.Buttons))
	legacyButtons := make([]*waProto.ButtonsMessage_Button, 0, len(req.Buttons))
	hasURLButton := false
	for index, button := range req.Buttons {
		buttonID := strings.TrimSpace(button.ID)
		if buttonID == "" {
			buttonID = strings.TrimSpace(button.ButtonID)
		}
		if buttonID == "" {
			buttonID = fmt.Sprintf("btn_%d", index+1)
		}
		displayText := strings.TrimSpace(button.Text)
		if displayText == "" {
			displayText = strings.TrimSpace(button.DisplayText)
		}
		if displayText == "" {
			http.Error(w, "button text is required", 400)
			return
		}
		buttonURL := strings.TrimSpace(button.URL)
		if buttonURL == "" {
			buttonURL = strings.TrimSpace(button.Link)
		}
		if buttonURL == "" {
			buttonURL = strings.TrimSpace(button.Href)
		}
		if buttonURL != "" {
			hasURLButton = true
		}
		buttonName := "quick_reply"
		params := map[string]string{
			"display_text": displayText,
			"id":           buttonID,
		}
		if buttonURL != "" {
			buttonName = "cta_url"
			params["url"] = buttonURL
			params["merchant_url"] = buttonURL
		}
		paramsJSON, _ := json.Marshal(params)
		nativeButtons = append(nativeButtons, &waProto.InteractiveMessage_NativeFlowMessage_NativeFlowButton{
			Name:             proto.String(buttonName),
			ButtonParamsJSON: proto.String(string(paramsJSON)),
		})
		legacyButtons = append(legacyButtons, &waProto.ButtonsMessage_Button{
			ButtonID: proto.String(buttonID),
			ButtonText: &waProto.ButtonsMessage_Button_ButtonText{
				DisplayText: proto.String(displayText),
			},
			Type: waProto.ButtonsMessage_Button_RESPONSE.Enum(),
		})
	}

	interactiveMsg := &waProto.InteractiveMessage{
		Body: &waProto.InteractiveMessage_Body{
			Text: proto.String(content),
		},
		InteractiveMessage: &waProto.InteractiveMessage_NativeFlowMessage_{
			NativeFlowMessage: &waProto.InteractiveMessage_NativeFlowMessage{
				Buttons:        nativeButtons,
				MessageVersion: proto.Int32(3),
			},
		},
	}
	if footer := strings.TrimSpace(req.Footer); footer != "" {
		interactiveMsg.Footer = &waProto.InteractiveMessage_Footer{
			Text: proto.String(footer),
		}
	}
	if title := strings.TrimSpace(req.Title); title != "" {
		interactiveMsg.Header = &waProto.InteractiveMessage_Header{
			Title: proto.String(title),
		}
	}
	legacyHeaderType := waProto.ButtonsMessage_EMPTY
	legacyMsg := &waProto.ButtonsMessage{
		ContentText: proto.String(content),
		FooterText:  proto.String(strings.TrimSpace(req.Footer)),
		Buttons:     legacyButtons,
		HeaderType:  &legacyHeaderType,
	}
	if title := strings.TrimSpace(req.Title); title != "" {
		legacyHeaderType = waProto.ButtonsMessage_TEXT
		legacyMsg.Header = &waProto.ButtonsMessage_Text{Text: title}
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	msg := &waProto.Message{InteractiveMessage: interactiveMsg}
	if !hasURLButton {
		msg = &waProto.Message{ButtonsMessage: legacyMsg}
	}
	resp, err := sendWithPreWarm(client, ctx, targetJid, msg)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

func (b *Bridge) handleSendList(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId  int                         `json:"account_id"`
		JID        string                      `json:"jid"`
		ForceNewQR bool                        `json:"force_new_qr"`
		Title      string                      `json:"title"`
		Text       string                      `json:"text"`
		Body       string                      `json:"body"`
		Footer     string                      `json:"footer"`
		ButtonText string                      `json:"buttonText"`
		Sections   []interactiveSectionRequest `json:"sections"`
		Rows       []interactiveRowRequest     `json:"rows"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	description := strings.TrimSpace(req.Text)
	if description == "" {
		description = strings.TrimSpace(req.Body)
	}
	if len(req.Sections) == 0 && len(req.Rows) > 0 {
		req.Sections = []interactiveSectionRequest{{Title: "Opcoes", Rows: req.Rows}}
	}
	if req.JID == "" || strings.TrimSpace(req.Title) == "" || description == "" || len(req.Sections) == 0 {
		http.Error(w, "jid, title, text and sections are required", 400)
		return
	}
	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if strings.TrimSpace(req.ButtonText) == "" {
		req.ButtonText = "Ver opcoes"
	}

	buttons := make([]*waProto.InteractiveMessage_NativeFlowMessage_NativeFlowButton, 0)
	totalRows := 0
	for sectionIndex, section := range req.Sections {
		if len(section.Rows) == 0 {
			continue
		}
		for rowIndex, row := range section.Rows {
			totalRows++
			if totalRows > 10 {
				http.Error(w, "list supports up to 10 rows", 400)
				return
			}
			rowID := strings.TrimSpace(row.ID)
			if rowID == "" {
				rowID = strings.TrimSpace(row.RowID)
			}
			if rowID == "" {
				rowID = fmt.Sprintf("row_%d_%d", sectionIndex+1, rowIndex+1)
			}
			title := strings.TrimSpace(row.Title)
			if title == "" {
				http.Error(w, "row title is required", 400)
				return
			}
			buttonParams, _ := json.Marshal(map[string]string{
				"display_text": title,
				"id":           rowID,
			})
			buttons = append(buttons, &waProto.InteractiveMessage_NativeFlowMessage_NativeFlowButton{
				Name:             proto.String("quick_reply"),
				ButtonParamsJSON: proto.String(string(buttonParams)),
			})
		}
	}
	if totalRows == 0 {
		http.Error(w, "at least one row is required", 400)
		return
	}

	interactiveMsg := &waProto.InteractiveMessage{
		Body: &waProto.InteractiveMessage_Body{
			Text: proto.String(description),
		},
		InteractiveMessage: &waProto.InteractiveMessage_NativeFlowMessage_{
			NativeFlowMessage: &waProto.InteractiveMessage_NativeFlowMessage{
				Buttons:        buttons,
				MessageVersion: proto.Int32(3),
			},
		},
	}
	if strings.TrimSpace(req.Footer) != "" {
		interactiveMsg.Footer = &waProto.InteractiveMessage_Footer{
			Text: proto.String(strings.TrimSpace(req.Footer)),
		}
	}
	title := strings.TrimSpace(req.Title)
	if title != "" {
		interactiveMsg.Header = &waProto.InteractiveMessage_Header{
			Title: proto.String(title),
		}
	}

	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	resp, err := sendWithPreWarm(client, ctx, targetJid, &waProto.Message{
		InteractiveMessage: interactiveMsg,
	})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

var privateIPBlocks []*net.IPNet

func init() {
	for _, cidr := range []string{
		"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
		"100.64.0.0/10", "198.18.0.0/15",
		"127.0.0.0/8", "169.254.0.0/16",
		"::1/128", "fc00::/7", "fe80::/10",
	} {
		_, block, _ := net.ParseCIDR(cidr)
		if block != nil {
			privateIPBlocks = append(privateIPBlocks, block)
		}
	}
}

func isSafeURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return fmt.Errorf("only HTTPS URLs are allowed")
	}
	host := parsed.Hostname()
	ips, err := net.LookupHost(host)
	if err != nil {
		return fmt.Errorf("cannot resolve host")
	}
	for _, ip := range ips {
		parsedIP := net.ParseIP(ip)
		if parsedIP == nil {
			continue
		}
		if parsedIP.IsLoopback() || parsedIP.IsPrivate() || parsedIP.IsUnspecified() {
			return fmt.Errorf("URL points to private/internal network")
		}
		for _, block := range privateIPBlocks {
			if block.Contains(parsedIP) {
				return fmt.Errorf("URL points to private/internal network")
			}
		}
	}
	return nil
}

func (b *Bridge) handleSendMedia(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])

	var req struct {
		AccountId  int    `json:"account_id"`
		JID        string `json:"jid"`
		ForceNewQR bool   `json:"force_new_qr"`
		MediaURL   string `json:"mediaUrl"`
		MimeType   string `json:"mimeType"`
		FileName   string `json:"fileName"`
		Caption    string `json:"caption"`
		Type       string `json:"type"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.MediaURL == "" {
		http.Error(w, "mediaUrl required", 400)
		return
	}
	if err := isSafeURL(req.MediaURL); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	resp, err := httpClient.Get(req.MediaURL)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		http.Error(w, "media download failed", 400)
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 25*1024*1024))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if req.MimeType == "" {
		req.MimeType = http.DetectContentType(data)
	}
	targetJid, err := b.prepareRecipient(client, req.JID)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	mediaType := whatsmeow.MediaDocument
	if strings.HasPrefix(req.MimeType, "image/") || req.Type == "image" {
		mediaType = whatsmeow.MediaImage
	} else if strings.HasPrefix(req.MimeType, "audio/") || req.Type == "audio" {
		mediaType = whatsmeow.MediaAudio
	}
	uploadCtx, uploadCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer uploadCancel()
	uploaded, err := client.Upload(uploadCtx, data, mediaType)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	msg := &waProto.Message{}
	if mediaType == whatsmeow.MediaImage {
		msg.ImageMessage = &waProto.ImageMessage{
			Caption:       proto.String(req.Caption),
			Mimetype:      proto.String(req.MimeType),
			URL:           &uploaded.URL,
			DirectPath:    &uploaded.DirectPath,
			MediaKey:      uploaded.MediaKey,
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    &uploaded.FileLength,
		}
	} else if mediaType == whatsmeow.MediaAudio {
		msg.AudioMessage = &waProto.AudioMessage{
			Mimetype:      proto.String(req.MimeType),
			URL:           &uploaded.URL,
			DirectPath:    &uploaded.DirectPath,
			MediaKey:      uploaded.MediaKey,
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    &uploaded.FileLength,
		}
	} else {
		fileName := req.FileName
		if fileName == "" {
			fileName = "arquivo"
		}
		msg.DocumentMessage = &waProto.DocumentMessage{
			Caption:       proto.String(req.Caption),
			Title:         proto.String(fileName),
			FileName:      proto.String(fileName),
			Mimetype:      proto.String(req.MimeType),
			URL:           &uploaded.URL,
			DirectPath:    &uploaded.DirectPath,
			MediaKey:      uploaded.MediaKey,
			FileEncSHA256: uploaded.FileEncSHA256,
			FileSHA256:    uploaded.FileSHA256,
			FileLength:    &uploaded.FileLength,
		}
	}
	sendCtx, sendCancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer sendCancel()
	sendResp, err := sendWithPreWarm(client, sendCtx, targetJid, msg)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(sendResp)
}

func (b *Bridge) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	b.mu.Lock()
	client, ok := b.clients[id]
	if ok {
		delete(b.clients, id)
	}
	b.connecting[id] = false
	delete(b.lastQR, id)
	b.mu.Unlock()
	if ok {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if err := client.Logout(ctx); err != nil {
			client.Disconnect()
			if client.Store != nil {
				_ = client.Store.Delete(context.Background())
			}
		}
		cancel()
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if deviceStore, err := b.getStoredDevice(ctx, id, ""); err == nil && deviceStore != nil {
			_ = deviceStore.Delete(context.Background())
		}
		cancel()
	}
	b.unbindInstanceDevice(id)
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (b *Bridge) handlePasskeyResponse(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	var req struct {
		AccountID int                    `json:"account_id"`
		Response  types.WebAuthnResponse `json:"response"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	client, ok := b.clients[id]
	b.mu.Unlock()
	if !ok || client == nil {
		http.Error(w, "instance is not waiting for passkey", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.SendPasskeyResponse(ctx, &req.Response); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "passkey_response_sent"})
}

func (b *Bridge) handlePasskeyConfirm(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	b.mu.Lock()
	client, ok := b.clients[id]
	b.mu.Unlock()
	if !ok || client == nil {
		http.Error(w, "instance is not waiting for passkey confirmation", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.SendPasskeyConfirmation(ctx); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "passkey_confirmed"})
}

func (b *Bridge) authorized(r *http.Request) bool {
	return r.Header.Get("X-Bridge-Token") == b.token
}

func (b *Bridge) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"service": "wooapi_bridge",
		"port":    3001,
	})
}

func (b *Bridge) handleDiagnosticsRestriction(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if !b.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	vars := mux.Vars(r)
	id, _ := strconv.Atoi(vars["id"])
	accountID, _ := strconv.Atoi(r.URL.Query().Get("account_id"))

	b.mu.Lock()
	client, ok := b.clients[id]
	b.mu.Unlock()

	if !ok {
		restoredClient, err := b.ensureUsableClient(id, accountID, "")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"connected": false, "loggedIn": false, "error": err.Error(),
			})
			return
		}
		client = restoredClient
	}

	result := b.checkAccountRestriction(client)
	b.mu.Lock()
	result["connecting"] = b.connecting[id]
	b.mu.Unlock()
	json.NewEncoder(w).Encode(result)
}

func main() {
	bridge := NewBridge()
	r := mux.NewRouter()

	r.HandleFunc("/health", bridge.handleHealth).Methods("GET")
	r.HandleFunc("/instances/{id}/connect", bridge.handleConnect).Methods("POST")
	r.HandleFunc("/instances/{id}/status", bridge.handleStatus).Methods("GET")
	r.HandleFunc("/instances/{id}/passkey/response", bridge.handlePasskeyResponse).Methods("POST")
	r.HandleFunc("/instances/{id}/passkey/confirm", bridge.handlePasskeyConfirm).Methods("POST")
	r.HandleFunc("/instances/{id}/send", bridge.handleSend).Methods("POST")
	r.HandleFunc("/instances/{id}/check-recipient", bridge.handleCheckRecipient).Methods("POST")
	r.HandleFunc("/instances/{id}/send-buttons", bridge.handleSendButtons).Methods("POST")
	r.HandleFunc("/instances/{id}/send-list", bridge.handleSendList).Methods("POST")
	r.HandleFunc("/instances/{id}/send-media", bridge.handleSendMedia).Methods("POST")
	r.HandleFunc("/instances/{id}/diagnostics/restriction", bridge.handleDiagnosticsRestriction).Methods("GET")
	bridge.registerAdvancedRoutes(r)
	bridge.registerNewFeatureRoutes(r)
	r.HandleFunc("/instances/{id}/logout", bridge.handleLogout).Methods("POST")

	fmt.Println("WooAPI Core running on :3001")

	srv := &http.Server{
		Addr:    ":3001",
		Handler: r,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil {
			fmt.Println(err)
		}
	}()

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	srv.Shutdown(context.Background())
}
