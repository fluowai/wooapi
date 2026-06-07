package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/mux"
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
	store.SetOSInfo("Wooapi", [3]uint32{0, 1, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	store.BaseClientPayload.UserAgent.Manufacturer = proto.String("Wooapi")
	store.BaseClientPayload.UserAgent.Device = proto.String("Desktop")

	logLevel := envOrDefault("BRIDGE_LOG_LEVEL", "INFO")
	dbLog := waLog.Stdout("Database", "ERROR", true)
	dbPath := envOrDefault("BRIDGE_DB_PATH", "wooapi_bridge.db")
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(15000)&_pragma=journal_mode(WAL)", dbPath)
	container, err := sqlstore.New(context.Background(), "sqlite", dsn, dbLog)
	if err != nil {
		panic(err)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		panic(err)
	}
	if _, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS wooapi_instance_devices (
			instance_id INTEGER PRIMARY KEY,
			jid TEXT NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		panic(err)
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
	resp, err := http.DefaultClient.Do(req)
	if err == nil && resp != nil {
		resp.Body.Close()
	}
}

func (b *Bridge) eventHandler(instanceId int, accountId int, evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		b.cacheMessage(instanceId, v)
		b.sendToNode("message", instanceId, accountId, v)
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
		firstQR := make(chan string, 1)
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
				if evt.Event == "code" {
					fmt.Printf("[QR] Instance %d: %s\n", id, evt.Code)
					b.mu.Lock()
					b.lastQR[id] = evt.Code
					b.mu.Unlock()
					select {
					case firstQR <- evt.Code:
					default:
					}
					b.sendToNode("qr", id, req.AccountId, map[string]string{"qr": evt.Code})
					qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				}
			}
		}()
		select {
		case code := <-firstQR:
			json.NewEncoder(w).Encode(map[string]string{"status": "qr", "qr": code})
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
	lidMigrationTimestamp := client.Store.LIDMigrationTimestamp
	client.Store.LIDMigrationTimestamp = 0
	resp, err := client.SendMessage(ctx, targetJid, &waProto.Message{
		Conversation: proto.String(req.Text),
	})
	client.Store.LIDMigrationTimestamp = lidMigrationTimestamp

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
	lidMigrationTimestamp := client.Store.LIDMigrationTimestamp
	client.Store.LIDMigrationTimestamp = 0
	msg := &waProto.Message{InteractiveMessage: interactiveMsg}
	if !hasURLButton {
		msg = &waProto.Message{ButtonsMessage: legacyMsg}
	}
	resp, err := client.SendMessage(ctx, targetJid, msg)
	client.Store.LIDMigrationTimestamp = lidMigrationTimestamp
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
	lidMigrationTimestamp := client.Store.LIDMigrationTimestamp
	client.Store.LIDMigrationTimestamp = 0
	resp, err := client.SendMessage(ctx, targetJid, &waProto.Message{
		InteractiveMessage: interactiveMsg,
	})
	client.Store.LIDMigrationTimestamp = lidMigrationTimestamp
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(resp)
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
	client, err := b.sendReadyClient(id, req.AccountId)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	resp, err := http.Get(req.MediaURL)
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
	sendResp, err := client.SendMessage(sendCtx, targetJid, msg)
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

func main() {
	bridge := NewBridge()
	r := mux.NewRouter()

	r.HandleFunc("/health", bridge.handleHealth).Methods("GET")
	r.HandleFunc("/instances/{id}/connect", bridge.handleConnect).Methods("POST")
	r.HandleFunc("/instances/{id}/status", bridge.handleStatus).Methods("GET")
	r.HandleFunc("/instances/{id}/send", bridge.handleSend).Methods("POST")
	r.HandleFunc("/instances/{id}/check-recipient", bridge.handleCheckRecipient).Methods("POST")
	r.HandleFunc("/instances/{id}/send-buttons", bridge.handleSendButtons).Methods("POST")
	r.HandleFunc("/instances/{id}/send-list", bridge.handleSendList).Methods("POST")
	r.HandleFunc("/instances/{id}/send-media", bridge.handleSendMedia).Methods("POST")
	bridge.registerAdvancedRoutes(r)
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
