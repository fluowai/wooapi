package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

type SessionInfo struct {
	Name       string                 `json:"name"`
	Status     string                 `json:"status"`
	Me         *MeInfo                `json:"me,omitempty"`
	Config     map[string]interface{} `json:"config,omitempty"`
	Presence   string                 `json:"presence,omitempty"`
	Timestamps map[string]interface{} `json:"timestamps,omitempty"`
}

type MeInfo struct {
	ID        string `json:"id"`
	PushName  string `json:"pushName"`
	JID       string `json:"jid,omitempty"`
	LID       string `json:"lid,omitempty"`
}

type SessionCreateRequest struct {
	Name    string                 `json:"name"`
	Start   *bool                  `json:"start"`
	Config  map[string]interface{} `json:"config,omitempty"`
	AccountID int                  `json:"account_id,omitempty"`
}

func (e *Engine) getOrCreateDeviceStore(ctx context.Context, session string, requestedJID string) (*store.Device, error) {
	requestedJID = strings.TrimSpace(requestedJID)
	if requestedJID != "" {
		devices, err := e.container.GetAllDevices(ctx)
		if err != nil {
			return nil, err
		}
		parsedJID, err := types.ParseJID(requestedJID)
		if err == nil && parsedJID.User != "" {
			nonAD := parsedJID.ToNonAD()
			for _, device := range devices {
				if device != nil && device.ID != nil && device.ID.ToNonAD() == nonAD {
					return device, nil
				}
			}
		}
	}
	boundJID := e.boundDeviceJID(session)
	if boundJID == "" {
		return nil, nil
	}
	devices, err := e.container.GetAllDevices(ctx)
	if err != nil {
		return nil, err
	}
	parsedJID, err := types.ParseJID(boundJID)
	if err != nil || parsedJID.User == "" {
		return nil, nil
	}
	nonAD := parsedJID.ToNonAD()
	for _, device := range devices {
		if device != nil && device.ID != nil && device.ID.ToNonAD() == nonAD {
			return device, nil
		}
	}
	return nil, nil
}

func (e *Engine) ensureUsableClient(session string, accountID int) (*whatsmeow.Client, error) {
	deadline := time.Now().Add(12 * time.Second)
	for {
		e.mu.Lock()
		connecting := e.connecting[session]
		client, ok := e.clients[session]
		e.mu.Unlock()
		if !connecting {
			if ok {
				if client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
					return client, nil
				}
				client.Disconnect()
				e.mu.Lock()
				if e.clients[session] == client {
					delete(e.clients, session)
				}
				e.connecting[session] = false
				e.mu.Unlock()
			}
			break
		}
		if ok && client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
			return client, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("session is still connecting")
		}
		time.Sleep(300 * time.Millisecond)
	}

	e.mu.Lock()
	if e.connecting[session] {
		e.mu.Unlock()
		return nil, fmt.Errorf("session is still connecting")
	}
	if client, ok := e.clients[session]; ok {
		if client.IsConnected() && client.Store != nil && client.Store.GetJID().User != "" {
			e.mu.Unlock()
			return client, nil
		}
		client.Disconnect()
		delete(e.clients, session)
		e.connecting[session] = false
	}
	e.connecting[session] = true
	e.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	deviceStore, err := e.getOrCreateDeviceStore(ctx, session, "")
	if err != nil {
		e.mu.Lock()
		e.connecting[session] = false
		e.mu.Unlock()
		return nil, err
	}
	if deviceStore == nil || deviceStore.ID == nil {
		e.mu.Lock()
		e.connecting[session] = false
		e.mu.Unlock()
		return nil, fmt.Errorf("paired device not found")
	}

	clientLog := waLog.Stdout("Client", e.logLevel, true)
	client := whatsmeow.NewClient(deviceStore, clientLog)
	e.mu.Lock()
	e.clients[session] = client
	e.mu.Unlock()
	client.AddEventHandler(func(evt interface{}) {
		e.eventHandler(session, evt)
	})

	if err := client.Connect(); err != nil {
		e.mu.Lock()
		e.connecting[session] = false
		if e.clients[session] == client {
			delete(e.clients, session)
		}
		e.mu.Unlock()
		return nil, err
	}
	client.WaitForConnection(8 * time.Second)
	e.mu.Lock()
	e.connecting[session] = false
	e.mu.Unlock()
	if !client.IsConnected() {
		return nil, fmt.Errorf("client not connected")
	}
	if client.Store == nil || client.Store.GetJID().User == "" {
		return nil, fmt.Errorf("the store doesn't contain a device JID")
	}
	return client, nil
}

func (e *Engine) handleListSessions(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	e.mu.Lock()
	all := make([]SessionInfo, 0)
	for name := range e.clients {
		client := e.clients[name]
		status := e.sessionStatus(name)
		info := SessionInfo{
			Name:     name,
			Status:   status,
			Presence: "online",
		}
		if client != nil && client.IsLoggedIn() && client.Store != nil {
			jid := client.Store.GetJID().ToNonAD()
			info.Me = &MeInfo{
				ID:       jid.String(),
				PushName: client.Store.PushName,
				JID:      client.Store.GetJID().String(),
			}
		}
		all = append(all, info)
	}
	e.mu.Unlock()
	if all == nil {
		all = []SessionInfo{}
	}
	writeJSON(w, http.StatusOK, all)
}

func (e *Engine) sessionStatus(session string) string {
	e.mu.Lock()
	client, ok := e.clients[session]
	connecting := e.connecting[session]
	_, hasQR := e.lastQR[session]
	e.mu.Unlock()

	if !ok {
		if connecting {
			if hasQR {
				return "STARTING"
			}
			return "CONNECTING"
		}
		return "STOPPED"
	}
	if client.IsLoggedIn() {
		return "RUNNING"
	}
	if client.IsConnected() {
		if hasQR {
			return "SCAN_QR_CODE"
		}
		return "CONNECTED"
	}
	if connecting {
		return "CONNECTING"
	}
	return "STOPPED"
}

func (e *Engine) handleGetSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)
	status := e.sessionStatus(session)
	info := SessionInfo{
		Name:   session,
		Status: status,
	}

	e.mu.Lock()
	client, ok := e.clients[session]
	e.mu.Unlock()
	if ok && client != nil && client.IsLoggedIn() && client.Store != nil {
		jid := client.Store.GetJID().ToNonAD()
		info.Me = &MeInfo{
			ID:       jid.String(),
			PushName: client.Store.PushName,
			JID:      client.Store.GetJID().String(),
		}
		info.Presence = "online"
	}
	info.Timestamps = map[string]interface{}{"activity": nil}
	writeJSON(w, http.StatusOK, info)
}

func (e *Engine) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req SessionCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "session name is required")
		return
	}
	session := req.Name

	e.mu.Lock()
	if _, exists := e.clients[session]; exists {
		e.mu.Unlock()
		writeError(w, http.StatusConflict, "session already exists")
		return
	}
	e.mu.Unlock()

	accountID := req.AccountID
	if accountID == 0 {
		accountID = e.getAccountID(session)
	}
	if accountID > 0 {
		e.mu.Lock()
		e.accountIDs[session] = accountID
		e.mu.Unlock()
	}

	start := true
	if req.Start != nil {
		start = *req.Start
	}

	if start {
		e.doStartSession(w, r, session, accountID)
		return
	}

	e.mu.Lock()
	e.connecting[session] = false
	e.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"name":   session,
		"status": "STOPPED",
	})
}

func (e *Engine) handleStartSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)
	accountID := e.getAccountID(session)
	e.doStartSession(w, r, session, accountID)
}

func (e *Engine) doStartSession(w http.ResponseWriter, r *http.Request, session string, accountID int) {
	e.mu.Lock()
	if b, ok := e.connecting[session]; ok && b {
		lastQR := e.lastQR[session]
		e.mu.Unlock()
		resp := map[string]interface{}{"name": session, "status": "CONNECTING"}
		if lastQR != "" {
			resp["status"] = "SCAN_QR_CODE"
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if client, ok := e.clients[session]; ok {
		if client.IsLoggedIn() && client.Store != nil && client.Store.ID != nil {
			e.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"name":   session,
				"status": "RUNNING",
			})
			return
		}
		client.Disconnect()
		delete(e.clients, session)
		e.connecting[session] = false
	}
	e.connecting[session] = true
	e.mu.Unlock()

	if accountID > 0 {
		e.mu.Lock()
		e.accountIDs[session] = accountID
		e.mu.Unlock()
		e.db.Exec("INSERT INTO engine_sessions (session_name, account_id) VALUES (?, ?) ON CONFLICT(session_name) DO UPDATE SET account_id = excluded.account_id", session, accountID)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deviceStore, err := e.getOrCreateDeviceStore(ctx, session, "")
	if err != nil {
		e.mu.Lock()
		e.connecting[session] = false
		e.mu.Unlock()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if deviceStore == nil {
		deviceStore = e.container.NewDevice()
	}

	clientLog := waLog.Stdout("Client", e.logLevel, true)
	client := whatsmeow.NewClient(deviceStore, clientLog)
	e.mu.Lock()
	e.clients[session] = client
	e.mu.Unlock()

	client.AddEventHandler(func(evt interface{}) {
		e.eventHandler(session, evt)
	})

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(context.Background())
		firstQR := make(chan string, 1)
		err = client.Connect()
		if err != nil {
			e.mu.Lock()
			e.connecting[session] = false
			if e.clients[session] == client {
				delete(e.clients, session)
			}
			e.mu.Unlock()
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}

		go func() {
			for evt := range qrChan {
				if evt.Event == "code" {
					fmt.Printf("[QR] Session %s: %s\n", session, evt.Code)
					e.mu.Lock()
					e.lastQR[session] = evt.Code
					e.mu.Unlock()
					select {
					case firstQR <- evt.Code:
					default:
					}
					e.sendToNode(session, "qr", map[string]string{"qr": evt.Code})
					qrterminal.GenerateHalfBlock(evt.Code, qrterminal.L, os.Stdout)
				}
			}
		}()

		select {
		case code := <-firstQR:
			writeJSON(w, http.StatusCreated, map[string]interface{}{
				"name":   session,
				"status": "SCAN_QR_CODE",
			})
			return
		case <-time.After(20 * time.Second):
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"name":   session,
				"status": "CONNECTING",
			})
			return
		}
	}

	err = client.Connect()
	if err != nil {
		e.mu.Lock()
		e.connecting[session] = false
		if e.clients[session] == client {
			delete(e.clients, session)
		}
		e.mu.Unlock()
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"name":   session,
		"status": "CONNECTING",
	})
}

func (e *Engine) handleStopSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)
	e.mu.Lock()
	client, ok := e.clients[session]
	if ok {
		delete(e.clients, session)
	}
	e.connecting[session] = false
	e.mu.Unlock()
	if ok {
		client.Disconnect()
	}
	e.sendToNode(session, "status", map[string]string{"status": "STOPPED"})
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"name":   session,
		"status": "STOPPED",
	})
}

func (e *Engine) handleLogoutSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)
	e.mu.Lock()
	client, ok := e.clients[session]
	if ok {
		delete(e.clients, session)
	}
	e.connecting[session] = false
	delete(e.lastQR, session)
	e.mu.Unlock()
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
		if deviceStore, err := e.getOrCreateDeviceStore(ctx, session, ""); err == nil && deviceStore != nil {
			_ = deviceStore.Delete(context.Background())
		}
		cancel()
	}
	e.unbindSessionDevice(session)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"name":   session,
		"status": "STOPPED",
	})
}

func (e *Engine) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	e.handleLogoutSession(w, r)
}

func (e *Engine) handleRestartSession(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)

	e.mu.Lock()
	client, ok := e.clients[session]
	if ok {
		delete(e.clients, session)
	}
	e.connecting[session] = false
	e.mu.Unlock()
	if ok {
		client.Disconnect()
	}

	accountID := e.getAccountID(session)
	e.doStartSession(w, r, session, accountID)
}

func (e *Engine) bindSessionDevice(session string, jid types.JID) {
	if session == "" || jid.User == "" || e.db == nil {
		return
	}
	e.mu.Lock()
	accountID := e.accountIDs[session]
	e.mu.Unlock()
	_, _ = e.db.Exec(
		"INSERT INTO engine_sessions (session_name, account_id, jid, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(session_name) DO UPDATE SET jid = excluded.jid, updated_at = CURRENT_TIMESTAMP",
		session, accountID, jid.String(),
	)
}

func (e *Engine) unbindSessionDevice(session string) {
	if session == "" || e.db == nil {
		return
	}
	_, _ = e.db.Exec("DELETE FROM engine_sessions WHERE session_name = ?", session)
}

func (e *Engine) boundDeviceJID(session string) string {
	if session == "" || e.db == nil {
		return ""
	}
	var jid string
	if err := e.db.QueryRow("SELECT jid FROM engine_sessions WHERE session_name = ?", session).Scan(&jid); err != nil {
		return ""
	}
	return strings.TrimSpace(jid)
}

func (e *Engine) handleNewMessageID(w http.ResponseWriter, r *http.Request) {
	if !e.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	session := sessionNameFromRequest(r)
	e.mu.Lock()
	client, ok := e.clients[session]
	e.mu.Unlock()
	if !ok || client == nil {
		writeError(w, http.StatusBadRequest, "session not active")
		return
	}
	id := client.GenerateMessageID()
	writeJSON(w, http.StatusOK, map[string]string{"id": string(id)})
}

func (e *Engine) getSessionClient(session string) (*whatsmeow.Client, error) {
	e.mu.Lock()
	client, ok := e.clients[session]
	e.mu.Unlock()
	if !ok || client == nil {
		return nil, fmt.Errorf("session '%s' not found or not running", session)
	}
	if !client.IsConnected() {
		return nil, fmt.Errorf("session '%s' is not connected", session)
	}
	if !client.IsLoggedIn() {
		return nil, fmt.Errorf("session '%s' is not logged in", session)
	}
	if client.Store == nil || client.Store.GetJID().User == "" {
		return nil, fmt.Errorf("session '%s' has no device JID", session)
	}
	return client, nil
}

func instanceIDFromSession(session string) int {
	id, _ := strconv.Atoi(session)
	return id
}
