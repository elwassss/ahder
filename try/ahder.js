const toast = document.getElementById("toast");
    let toastTimer;

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add("show");
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2400);
    }

    async function apiRequest(url, options = {}) {
      const headers = new Headers(options.headers || {});
      const isFormData = options.body instanceof FormData;
      if (options.body && !isFormData) headers.set("Content-Type", "application/json");
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers
      });
      if (response.status === 204) return null;
      const result = response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : { error: await response.text() };
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
      return result;
    }

    function showAuthError(message) {
      const error = document.getElementById("authError");
      error.textContent = message;
      error.hidden = false;
    }

    function clearAuthError() {
      const error = document.getElementById("authError");
      error.textContent = "";
      error.hidden = true;
    }

    const authScreen = document.getElementById("authScreen");
    const appShell = document.getElementById("appShell");
    const modalBackdrop = document.getElementById("modalBackdrop");
    const modalCard = document.getElementById("modalCard");
    const defaultAvatar = "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&h=100&q=80";
    const profileStorageKey = "ahder-profile-v1";
    const savedStorageKey = "ahder-saved-posts-v1";
    let userProfile = {
      name: "Alex Morgan",
      username: "",
      email: "",
      university: "Northwood University",
      major: "Design & Media",
      bio: "Making things, meeting people, and finding the best coffee on campus.",
      avatar: defaultAvatar
    };
    let pendingMedia = null;
    let savedPostIds = new Set();
    let notificationItems = [
      { icon: "♥", text: "Maya Chen and 12 others liked a campus post.", time: "12 min ago", page: "Home" },
      { icon: "✦", text: "Design Society shared a new gallery update.", time: "24 min ago", page: "Design Society" },
      { icon: "📅", text: "Fall Fest on the Quad is coming up tomorrow.", time: "1 hr ago", page: "Events" }
    ];
    let followingPeople = new Set();

    function setTheme(theme) {
      const isDark = theme === "dark";
      document.body.dataset.theme = isDark ? "dark" : "light";
      const toggle = document.querySelector(".theme-toggle");
      const sunIcon = toggle.querySelector(".theme-icon-sun");
      const moonIcon = toggle.querySelector(".theme-icon-moon");
      toggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
      toggle.title = `Switch to ${isDark ? "light" : "dark"} mode`;
      sunIcon.hidden = isDark;
      moonIcon.hidden = !isDark;
    }

    setTheme(readStorage("ahder-theme-v1", "light"));

    function readStorage(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
      } catch (error) {
        showToast(`Could not read your saved browser data: ${error.message}`);
        return fallback;
      }
    }

    function writeStorage(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        showToast(`Could not save in this browser: ${error.message}`);
        return false;
      }
    }

    function escapeHTML(value) {
      return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[character]);
    }

    function applyProfile() {
      document.querySelectorAll(".user-avatar").forEach((image) => {
        image.src = userProfile.avatar || defaultAvatar;
        image.alt = `${userProfile.name} profile photo`;
      });
      document.querySelectorAll(".welcome h1").forEach((heading) => {
        if (heading.textContent.startsWith("Hey,")) heading.textContent = `Hey, ${userProfile.name.split(" ")[0]}! 👋`;
      });
      const university = document.getElementById("campusUniversity");
      if (university) university.textContent = userProfile.university || "Your university";
      const composer = document.getElementById("postText");
      if (composer) composer.placeholder = `What's happening on campus, ${userProfile.name.split(" ")[0]}?`;
    }

    async function enterApp(profile) {
      userProfile = { ...userProfile, ...profile };
      if (!userProfile.avatar) userProfile.avatar = defaultAvatar;
      authScreen.hidden = true;
      appShell.hidden = false;
      clearAuthError();
      applyProfile();
      try {
        await refreshRemotePosts();
      } catch (error) {
        showToast(`Could not load campus posts: ${error.message}`);
      }
      showToast(`Welcome to Ahder, ${userProfile.name.split(" ")[0]}!`);
    }

    async function signOut() {
      try {
        await apiRequest("/api/auth/logout", { method: "POST" });
      } catch (error) {
        showToast(`Could not sign out: ${error.message}`);
        return;
      }
      searchInput.value = "";
      document.querySelectorAll(".nav-link").forEach((item) => {
        item.classList.toggle("active", item.dataset.nav === "Home");
      });
      showFeedPage("Home");
      closeModal();
      appShell.hidden = true;
      authScreen.hidden = false;
      document.getElementById("signInForm").hidden = false;
      document.getElementById("createAccountForm").hidden = true;
      showToast("You have signed out.");
    }

    function openModal(title, body, className = "") {
      modalCard.className = `modal-card ${className}`.trim();
      modalCard.innerHTML = `<header class="modal-head"><h2 id="modalTitle">${escapeHTML(title)}</h2><button class="modal-close" type="button" data-close-modal aria-label="Close">×</button></header>${body}`;
      modalBackdrop.hidden = false;
      const firstInput = modalCard.querySelector("input:not([type=hidden]), textarea, button");
      if (firstInput) firstInput.focus();
    }

    function closeModal() {
      modalBackdrop.hidden = true;
      modalCard.replaceChildren();
    }

    function closeMobileNavigation() {
      const rail = document.getElementById("leftRail");
      const trigger = document.querySelector('[data-action="mobileMenu"]');
      if (!rail || !trigger) return;
      rail.classList.remove("mobile-open");
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", "Open navigation menu");
    }

    function openInviteLink(url) {
      openModal("Invite friends to Ahder", `
        <p class="page-description">Share this link so your friends can join your campus community.</p>
        <label class="auth-field"><span>Ahder link</span><input id="inviteLink" value="${escapeHTML(url)}" readonly></label>
        <button class="primary-button" type="button" data-copy-invite>Copy invite link</button>
        <p class="page-description invite-note">Friends need a publicly reachable Ahder website link; a localhost link only works on your computer.</p>`);
      modalCard.querySelector("#inviteLink").select();
    }

    function openInfo(title) {
      const messages = {
        "About Ahder": "Ahder is a campus community demo for sharing university moments, discovering student groups, and finding events. This page is a frontend prototype.",
        "Community guidelines": "Be kind, respect privacy, credit creators, and keep campus discussions welcoming. You can use the report option on any post to flag content in this demo.",
        "Privacy settings": "This prototype keeps profile details, saved posts, and sign-in state in this browser only. It does not connect to a server or send your information anywhere."
      };
      openModal(title, `<p class="page-description">${escapeHTML(messages[title] || title)}</p><button class="primary-button" type="button" data-close-modal>Got it</button>`);
    }

    function loadPhoto(file, callback) {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showToast("Choose an image file.");
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        showToast("Choose an image smaller than 8 MB.");
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => showToast("The image could not be opened. Please try another file.");
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => showToast("The selected file is not a valid image.");
        image.onload = () => {
          const scale = Math.min(1, 900 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          if (!context) {
            showToast("Your browser could not process this image.");
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          callback(canvas.toDataURL("image/jpeg", .82));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    function loadPostMedia(file, callback) {
      if (!file) return;
      if (file.type.startsWith("image/")) {
        loadPhoto(file, (src) => callback({ type: "image", src, name: file.name, file }));
        return;
      }
      if (file.type.startsWith("video/")) {
        if (file.size > 50 * 1024 * 1024) {
          showToast("Choose a video smaller than 50 MB.");
          return;
        }
        callback({
          type: "video",
          src: URL.createObjectURL(file),
          name: file.name,
          file
        });
        return;
      }
      showToast("Choose an image or video file.");
    }

    document.getElementById("signInForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      clearAuthError();
      try {
        const result = await apiRequest("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: String(data.get("email")).trim(),
            password: String(data.get("password"))
          })
        });
        await enterApp(result.user);
      } catch (error) {
        showAuthError(error.message);
      }
    });

    document.getElementById("createAccountForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      clearAuthError();
      try {
        const result = await apiRequest("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            name: String(data.get("name")).trim(),
            username: String(data.get("username")).trim().toLowerCase(),
            email: String(data.get("email")).trim(),
            password: String(data.get("password"))
          })
        });
        await enterApp(result.user);
      } catch (error) {
        showAuthError(error.message);
      }
    });

    document.querySelectorAll("[data-auth-switch]").forEach((button) => {
      button.addEventListener("click", () => {
        const create = button.dataset.authSwitch === "create";
        clearAuthError();
        document.getElementById("signInForm").hidden = create;
        document.getElementById("createAccountForm").hidden = !create;
      });
    });

    document.querySelector("[data-sign-in-demo]").addEventListener("click", async () => {
      clearAuthError();
      try {
        const result = await apiRequest("/api/auth/demo", { method: "POST" });
        await enterApp(result.user);
      } catch (error) {
        showAuthError(error.message);
      }
    });

    async function initializeBackend() {
      const authError = new URLSearchParams(window.location.search).get("authError");
      if (authError === "cancelled") showAuthError("Sign-in was cancelled. You can try again.");
      try {
        const providers = await apiRequest("/api/auth/providers");
        document.querySelectorAll("[data-oauth-provider]").forEach((link) => {
          const enabled = Boolean(providers[link.dataset.oauthProvider]);
          link.setAttribute("aria-disabled", String(!enabled));
          link.classList.toggle("is-disabled", !enabled);
          link.setAttribute("tabindex", enabled ? "0" : "-1");
          if (enabled) {
            link.removeAttribute("data-disabled-reason");
            link.title = `Continue with ${link.dataset.oauthProvider === "apple" ? "Apple" : "Google"}`;
            return;
          }
          link.dataset.disabledReason = `Configure ${link.dataset.oauthProvider === "apple" ? "Apple" : "Google"} OAuth in try backend/.env first.`;
          link.title = link.dataset.disabledReason;
        });
        const result = await apiRequest("/api/auth/session");
        if (result.user) await enterApp(result.user);
      } catch (error) {
        showAuthError(`Could not connect to Ahder's server: ${error.message}. Start the server and open this page at http://localhost:3000.`);
      }
    }

    document.querySelectorAll("[data-oauth-provider]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (link.getAttribute("aria-disabled") === "true") {
          event.preventDefault();
          event.stopPropagation();
          showAuthError(link.dataset.disabledReason || link.title || "This sign-in option is not available yet.");
        }
      });
    });

    try {
      savedPostIds = new Set(JSON.parse(localStorage.getItem(savedStorageKey) || "[]"));
      followingPeople = new Set(JSON.parse(localStorage.getItem("ahder-following-v1") || "[]"));
    } catch (error) {
      showToast(`Some saved browser data could not be loaded: ${error.message}`);
    }
    document.querySelectorAll(".right-rail .follow-button").forEach((button) => {
      const name = button.previousElementSibling.querySelector("strong").textContent;
      const following = followingPeople.has(name);
      button.setAttribute("aria-pressed", String(following));
      button.classList.toggle("following", following);
      button.textContent = following ? "✓" : "+";
      button.setAttribute("aria-label", `${following ? "Unfollow" : "Follow"} ${name}`);
    });

    const feed = document.querySelector(".feed");
    const pageView = document.getElementById("pageView");
    const welcome = document.querySelector(".welcome");
    const welcomeTitle = welcome.querySelector("h1");
    const welcomeDescription = welcome.querySelector(".welcome-copy p:last-child");
    const originalWelcomeTitle = welcomeTitle.textContent;
    const originalWelcomeDescription = welcomeDescription.textContent;
    const postForm = document.getElementById("postForm");
    const feedTabs = document.querySelector(".feed-tabs");
    const emptyState = document.getElementById("emptyState");
    let currentPage = "Home";
    let activeCommunity = "";
    let currentFeedTab = "For you";
    feed.querySelectorAll(".post[data-post-id]").forEach((post) => {
      post.dataset.saved = String(savedPostIds.has(post.dataset.postId));
      const saveButton = post.querySelector(".save-button");
      if (saveButton && post.dataset.saved === "true") {
        saveButton.setAttribute("aria-pressed", "true");
        saveButton.classList.add("liked");
      }
    });

    function updatePosts() {
      const query = searchInput.value.trim().toLowerCase().replace(/^#/, "");
      let visibleCount = 0;
      const posts = feed.querySelectorAll(".post");

      posts.forEach((post) => {
        const matchesQuery = !query || post.dataset.searchable.includes(query) || post.textContent.toLowerCase().includes(query);
        let matchesPage = true;
        if (currentPage === "Saved") matchesPage = post.dataset.saved === "true";
        if (activeCommunity) matchesPage = post.dataset.searchable.includes(activeCommunity.toLowerCase());
        if (currentFeedTab === "Following" && post.dataset.followed !== "true") matchesPage = false;
        const visible = matchesQuery && matchesPage;
        post.hidden = !visible;
        if (visible) visibleCount++;
      });

      emptyState.style.display = visibleCount ? "none" : "block";
      if (!visibleCount) {
        emptyState.textContent = currentPage === "Saved"
          ? "You haven't saved any posts yet. Use the Save button on a post to keep it here."
          : currentFeedTab === "Following"
            ? "Your Following feed is empty. Follow campus people to see their posts here."
          : activeCommunity
            ? `No posts in ${activeCommunity} yet. Check back soon.`
            : "No posts match your search. Try another keyword.";
      }
    }

    function showPollResults(poll, votes) {
      const total = votes.reduce((sum, count) => sum + count, 0);
      poll.dataset.votes = JSON.stringify(votes);
      poll.querySelectorAll(".poll-option").forEach((option, index) => {
        const percentage = total ? Math.round(votes[index] / total * 100) : 0;
        option.querySelector(".poll-result-fill").style.width = `${percentage}%`;
        option.querySelector(".poll-votes").textContent = total
          ? `${votes[index]} ${votes[index] === 1 ? "vote" : "votes"} · ${percentage}%`
          : "0 votes";
        option.disabled = true;
      });
    }

    async function publishRemotePost(text, media = null, pollOptions = null) {
      const formData = new FormData();
      formData.append("body", text);
      if (media?.file) formData.append("media", media.file, media.name || media.file.name);
      if (pollOptions) formData.append("pollOptions", JSON.stringify(pollOptions));
      const result = await apiRequest("/api/posts", { method: "POST", body: formData });
      const serverPost = result.post;
      const postMedia = serverPost.media_url
        ? { type: serverPost.media_type, src: serverPost.media_url }
        : null;
      const poll = Array.isArray(serverPost.poll_options) ? { options: serverPost.poll_options } : null;
      return createPost(serverPost.body, postMedia, poll, serverPost);
    }

    async function refreshRemotePosts(savedOnly = currentPage === "Saved", followingOnly = false) {
      const query = new URLSearchParams();
      if (savedOnly) query.set("saved", "true");
      if (followingOnly) query.set("following", "true");
      const result = await apiRequest(`/api/posts${query.size ? `?${query}` : ""}`);
      feed.querySelectorAll(".post[data-server-post-id]").forEach((post) => post.remove());
      result.posts.slice().reverse().forEach((serverPost) => {
        const media = serverPost.media_url
          ? { type: serverPost.media_type, src: serverPost.media_url }
          : null;
        const poll = Array.isArray(serverPost.poll_options)
          ? { options: serverPost.poll_options }
          : null;
        const post = createPost(serverPost.body, media, poll, serverPost);
        post.dataset.serverPostId = serverPost.id;
        post.dataset.followed = String(Boolean(serverPost.followed) || serverPost.user_id === userProfile.id);
      });
      updatePosts();
    }

    function showFeedPage(page, community = "") {
      currentPage = page;
      activeCommunity = community;
      pageView.hidden = true;
      welcome.hidden = false;
      feedTabs.hidden = page === "Saved";
      postForm.hidden = page === "Saved";
      document.querySelectorAll(".feed-tab").forEach((tab, index) => {
        const selected = index === 0;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      });
      currentFeedTab = "For you";

      if (page === "Explore") {
        welcomeTitle.textContent = "Explore your campus 🌎";
        welcomeDescription.textContent = "Find posts, people, and ideas from your university.";
      } else if (page === "Saved") {
        welcomeTitle.textContent = "Your saved posts 🔖";
        welcomeDescription.textContent = "The posts you save are collected here.";
      } else if (community) {
        welcomeTitle.textContent = `${community} ✨`;
        welcomeDescription.textContent = "Posts and updates from your campus community.";
      } else {
        welcomeTitle.textContent = page === "Home" ? `Hey, ${userProfile.name.split(" ")[0]}! 👋` : originalWelcomeTitle;
        welcomeDescription.textContent = originalWelcomeDescription;
      }

      updatePosts();
      if (page === "Saved") refreshRemotePosts(true).catch((error) => showToast(`Could not load saved posts: ${error.message}`));
      if (page === "Explore") searchInput.focus();
    }

    function dateAfter(days) {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return date;
    }

    const welcomeDate = document.querySelector(".welcome-eyebrow");
    welcomeDate.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long", month: "long", day: "numeric"
    }).format(new Date()).toUpperCase();

    const campusEvents = [
      { day: String(dateAfter(1).getDate()), month: dateAfter(1).toLocaleString(undefined, { month: "short" }).toUpperCase(), name: "Fall Fest on the Quad", time: "4:00 PM", place: "Central Green", color: "purple" },
      { day: String(dateAfter(3).getDate()), month: dateAfter(3).toLocaleString(undefined, { month: "short" }).toUpperCase(), name: "Design Portfolio Night", time: "6:30 PM", place: "Arts Building", color: "orange" },
      { day: String(dateAfter(5).getDate()), month: dateAfter(5).toLocaleString(undefined, { month: "short" }).toUpperCase(), name: "Open Mic & Coffee", time: "7:00 PM", place: "The Commons", color: "green" }
    ];
    const attendingEvents = new Set(readStorage("ahder-attending-events-v1", []));
    document.querySelectorAll(".right-rail .event").forEach((eventLink, index) => {
      const date = dateAfter([1, 3, 5][index]);
      eventLink.querySelector(".event-date strong").textContent = String(date.getDate());
      eventLink.querySelector(".event-date span").textContent = date.toLocaleString(undefined, { month: "short" }).toUpperCase();
    });

    async function showEventsPage() {
      currentPage = "Events";
      activeCommunity = "";
      pageView.hidden = false;
      welcome.hidden = true;
      postForm.hidden = true;
      feedTabs.hidden = true;
      emptyState.style.display = "none";
      feed.querySelectorAll(".post").forEach((post) => { post.hidden = true; });
      welcomeTitle.textContent = "Campus events 📅";
      welcomeDescription.textContent = "Find something fun to do and let people know you're going.";
      pageView.innerHTML = `<h1 class="page-heading">Campus events 📅</h1><p class="page-description">Loading campus events…</p>`;
      try {
        const result = await apiRequest("/api/events");
        pageView.innerHTML = `
          <h1 class="page-heading">Campus events 📅</h1>
          <p class="page-description">Find something fun to do and let people know you're going.</p>
          ${result.events.length ? result.events.map((item) => {
            const date = new Date(`${String(item.event_date).slice(0, 10)}T00:00:00`);
            return `<article class="card event-page-card">
              <span class="event-date"><strong>${date.getDate()}</strong><span>${date.toLocaleString(undefined, { month: "short" }).toUpperCase()}</span></span>
              <span class="event-info"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.event_time)} · ${escapeHTML(item.place)} · ${escapeHTML(item.author_name)}</small></span>
              <button class="rsvp-button ${item.attending ? "joined" : ""}" type="button" data-rsvp-id="${escapeHTML(item.id)}" aria-pressed="${item.attending}">${item.attending ? "Going ✓" : "I'm going"} <small>${item.attendee_count}</small></button>
            </article>`;
          }).join("") : `<p class="page-description">No upcoming events yet. Create one from your campus feed.</p>`}`;
      } catch (error) {
        pageView.innerHTML = `<h1 class="page-heading">Campus events 📅</h1><p class="page-description">Could not load events: ${escapeHTML(error.message)}</p>`;
      }
    }

    async function openPeoplePage() {
      currentPage = "People";
      pageView.hidden = false;
      welcome.hidden = true;
      postForm.hidden = true;
      feedTabs.hidden = true;
      emptyState.style.display = "none";
      feed.querySelectorAll(".post").forEach((post) => { post.hidden = true; });
      pageView.innerHTML = `<h1 class="page-heading">Find your people ✨</h1><p class="page-description">Meet students from your campus.</p><p class="page-description">Loading students…</p>`;
      try {
        const result = await apiRequest(`/api/people?q=${encodeURIComponent(searchInput.value.trim())}`);
        result.people.forEach((person) => {
          if (person.following) followingPeople.add(person.name);
          else followingPeople.delete(person.name);
        });
        pageView.innerHTML = `
          <h1 class="page-heading">Find your people ✨</h1>
          <p class="page-description">Meet students from your campus.</p>
          <div class="card people-list-card">
            ${result.people.length ? result.people.map((person) => `
              <div class="person">
                <img class="avatar avatar-lg" src="${escapeHTML(person.avatar_url || defaultAvatar)}" alt="">
                <button class="person-info person-profile-link" type="button" data-open-profile="${escapeHTML(person.id)}"><strong>${escapeHTML(person.name)}</strong><small>@${escapeHTML(person.username || "")}${[person.major, person.university].filter(Boolean).length ? ` · ${escapeHTML([person.major, person.university].filter(Boolean).join(" · "))}` : ""}</small></button>
                <button class="follow-button ${person.following ? "following" : ""}" data-user-id="${escapeHTML(person.id)}" type="button" aria-label="${person.following ? "Unfollow" : "Follow"} ${escapeHTML(person.name)}" aria-pressed="${person.following}">${person.following ? "✓" : "+"}</button>
              </div>`).join("") : `<p class="page-description">No other students have joined yet. Invite a friend to create an account and connect here.</p>`}
          </div>`;
      } catch (error) {
        pageView.innerHTML = `<h1 class="page-heading">Find your people ✨</h1><p class="page-description">Could not load students: ${escapeHTML(error.message)}</p>`;
      }
    }

    function openNotifications() {
      document.querySelector(".notification-dot").hidden = true;
      const items = notificationItems.length
        ? notificationItems.map((item, index) => `
          <button class="notification-item" type="button" data-notification="${index}">
            <span class="notification-icon">${escapeHTML(item.icon)}</span>
            <span class="person-info"><strong>${escapeHTML(item.text)}</strong><small>${escapeHTML(item.time)}</small></span>
          </button>`).join("")
        : `<p class="page-description">You're all caught up. New campus updates will appear here.</p>`;
      openModal("Notifications", `<div class="toast-stack">${items}</div><button class="secondary-button notifications-clear-button" type="button" data-clear-notifications>Mark all as read</button>`);
    }

    function openComments(post) {
      activePost = post;
      if (post.dataset.serverPostId) {
        apiRequest(`/api/posts/${encodeURIComponent(post.dataset.serverPostId)}/comments`)
          .then((result) => showComments(post, result.comments))
          .catch((error) => showToast(`Could not load comments: ${error.message}`));
        return;
      }
      showComments(post, JSON.parse(post.dataset.comments || "[]"));
    }

    function showComments(post, comments) {
      activePost = post;
      const list = comments.length
        ? comments.map((comment) => `<div class="comment-item"><img class="avatar avatar-sm" src="${escapeHTML(comment.avatar || userProfile.avatar || defaultAvatar)}" alt=""><div class="comment-bubble"><strong>${escapeHTML(comment.name)}</strong>${escapeHTML(comment.text)}</div></div>`).join("")
        : `<p class="page-description">No comments yet. Start the conversation!</p>`;
      openModal("Comments", `<div class="comment-list">${list}</div><form class="modal-form" id="commentForm"><input name="comment" placeholder="Write a comment..." maxlength="240" required><button class="primary-button" type="submit">Send</button></form>`);
    }

    async function deletePost(post) {
      if (!post.dataset.serverPostId) {
        showToast("Only posts saved to your account can be deleted.");
        return;
      }
      try {
        await apiRequest(`/api/posts/${encodeURIComponent(post.dataset.serverPostId)}`, { method: "DELETE" });
        document.querySelectorAll(`[data-server-post-id="${CSS.escape(post.dataset.serverPostId)}"]`).forEach((item) => item.remove());
        savedPostIds.delete(post.dataset.serverPostId);
        writeStorage(savedStorageKey, [...savedPostIds]);
        const postList = pageView.querySelector(".profile-post-list");
        if (postList && !postList.querySelector(".post")) {
          postList.innerHTML = `<p class="page-description">You haven't shared any posts yet.</p>`;
        }
        closeModal();
        updatePosts();
        showToast("Your post was deleted.");
      } catch (error) {
        showToast(`Could not delete this post: ${error.message}`);
      }
    }

    let activePost = null;

    function createPost(text, media = null, poll = null, serverPost = null, container = null) {
      const post = document.createElement("article");
      const postId = serverPost?.id || `post-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      post.className = "card post";
      post.dataset.postId = postId;
      if (serverPost) post.dataset.serverPostId = serverPost.id;
      if (serverPost) post.dataset.authorId = serverPost.user_id;
      post.dataset.searchable = `${text} ${poll ? poll.options.join(" ") : ""}`.toLowerCase();
      post.dataset.comments = JSON.stringify(serverPost?.comments || []);
      post.dataset.saved = String(Boolean(serverPost?.saved));
      post.innerHTML = `
        <header class="post-header">
          <img class="avatar user-avatar" src="${escapeHTML(userProfile.avatar || defaultAvatar)}" alt="${escapeHTML(userProfile.name)} profile photo">
          <div class="post-author"><div class="author-line"><button class="author-name" type="button" data-open-profile="${escapeHTML(serverPost?.user_id || userProfile.id || "")}">${escapeHTML(userProfile.name)}</button></div><div class="post-meta">Just now</div></div>
          <button class="post-menu" type="button" aria-label="More post options" data-action="postMenu">···</button>
        </header>
        <p class="post-copy"></p>
        <div class="post-attachment"></div>
        <div class="post-stats"><span><i class="reaction-dot">♥</i><span><b class="like-count">0</b> reactions</span></span><span class="comment-count">Be the first to comment</span></div>
        <div class="post-actions">
          <button class="post-action like-button" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z"/></svg>Like</button>
          <button class="post-action" type="button" data-action="comment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>Comment</button>
          <button class="post-action save-button" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4z"/></svg>Save</button>
        </div>`;
      if (serverPost?.author_avatar !== undefined) {
        post.querySelector(".post-menu").dataset.authorId = serverPost.user_id;
      }
      post.querySelector(".post-copy").textContent = text;
      if (serverPost) {
        const avatar = post.querySelector(".user-avatar");
        avatar.src = serverPost.author_avatar || defaultAvatar;
        avatar.alt = `${serverPost.author_name} profile photo`;
        post.querySelector(".author-name").textContent = serverPost.author_name;
        post.dataset.followed = String(Boolean(serverPost.followed) || serverPost.user_id === userProfile.id);
        const createdAt = new Date(serverPost.created_at);
        post.querySelector(".post-meta").textContent = Number.isNaN(createdAt.getTime())
          ? "On campus"
          : createdAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        post.querySelector(".like-count").textContent = String(serverPost.like_count || 0);
        post.querySelector(".comment-count").textContent = serverPost.comment_count
          ? `${serverPost.comment_count} ${serverPost.comment_count === 1 ? "comment" : "comments"}`
          : "Be the first to comment";
        const likeButton = post.querySelector(".like-button");
        likeButton.setAttribute("aria-pressed", String(Boolean(serverPost.liked)));
        likeButton.classList.toggle("liked", Boolean(serverPost.liked));
        const saveButton = post.querySelector(".save-button");
        saveButton.setAttribute("aria-pressed", String(Boolean(serverPost.saved)));
        saveButton.classList.toggle("liked", Boolean(serverPost.saved));
      }
      if (media) {
        const attachment = media.type === "video"
          ? document.createElement("video")
          : document.createElement("img");
        attachment.className = media.type === "video" ? "post-video" : "post-image";
        attachment.src = media.src;
        if (media.type === "video") {
          attachment.controls = true;
          attachment.playsInline = true;
          attachment.preload = "metadata";
          attachment.setAttribute("aria-label", `Video post${media.name ? `: ${media.name}` : ""}`);
        } else {
          attachment.alt = "Image attached to campus post";
        }
        post.querySelector(".post-attachment").append(attachment);
      }
      if (poll) {
        const pollCard = document.createElement("div");
        pollCard.className = "poll-card";
        pollCard.innerHTML = poll.options.map((option, index) => `
          <button class="poll-option" type="button" data-poll-option="${index}">
            <span class="poll-option-label">${escapeHTML(option)}</span>
            <span class="poll-result"><span class="poll-result-fill"></span></span>
            <strong class="poll-votes">0 votes</strong>
          </button>`).join("");
        pollCard.dataset.votes = JSON.stringify(poll.options.map(() => 0));
        if (serverPost) {
          const counts = poll.options.map(() => 0);
          (serverPost.poll_votes || []).forEach((vote) => {
            counts[Number(vote.option_index)] = Number(vote.count);
          });
          const totalVotes = counts.reduce((sum, count) => sum + count, 0);
          pollCard.dataset.votes = JSON.stringify(counts);
          post.dataset.voted = String(Boolean(serverPost.voted));
          pollCard.querySelectorAll(".poll-option").forEach((option, index) => {
            const percentage = totalVotes ? Math.round(counts[index] / totalVotes * 100) : 0;
            option.querySelector(".poll-result-fill").style.width = `${percentage}%`;
            option.querySelector(".poll-votes").textContent = totalVotes
              ? `${counts[index]} ${counts[index] === 1 ? "vote" : "votes"} · ${percentage}%`
              : "0 votes";
            option.disabled = Boolean(serverPost.voted);
          });
        }
        post.querySelector(".post-attachment").append(pollCard);
      }
      if (container) container.append(post);
      else feedTabs.after(post);
      updatePosts();
      return post;
    }

    let currentPostMenu = null;

    let activeConversationId = null;
    let activeConversationType = "direct";
    let selectedGroupMembers = null;

    async function showMessagesPage(conversationId = activeConversationId, conversationType = activeConversationType) {
      currentPage = "Messages";
      activeCommunity = "";
      pageView.hidden = false;
      welcome.hidden = true;
      postForm.hidden = true;
      feedTabs.hidden = true;
      emptyState.style.display = "none";
      feed.querySelectorAll(".post").forEach((post) => { post.hidden = true; });
      pageView.innerHTML = `<h1 class="page-heading">Messages 💬</h1><p class="page-description">Private conversations with Ahder students.</p><p class="page-description">Loading conversations…</p>`;
      try {
        const [directResult, groupResult] = await Promise.all([
          apiRequest("/api/messages/conversations"),
          apiRequest("/api/groups")
        ]);
        const direct = directResult.conversations;
        const groups = groupResult.groups;
        const selectedType = conversationId ? conversationType : (direct.length ? "direct" : "group");
        const selectedId = conversationId || direct[0]?.id || groups[0]?.id || null;
        if (!selectedId) {
          activeConversationId = null;
          activeConversationType = "direct";
          renderMessagesPage(direct, groups, null, "direct");
          return;
        }
        const conversation = selectedType === "group"
          ? await apiRequest(`/api/groups/${encodeURIComponent(selectedId)}`)
          : await apiRequest(`/api/messages/${encodeURIComponent(selectedId)}`);
        activeConversationId = selectedId;
        activeConversationType = selectedType;
        renderMessagesPage(direct, groups, conversation, selectedType);
      } catch (error) {
        pageView.innerHTML = `<h1 class="page-heading">Messages 💬</h1><p class="page-description">Could not load messages: ${escapeHTML(error.message)}</p>`;
      }
    }

    function renderMessagesPage(conversations, groups, conversation, conversationType) {
      const partner = conversation?.partner;
      const group = conversation?.group;
      const contacts = conversations.slice();
      if (partner && !contacts.some((contact) => contact.id === partner.id)) contacts.unshift(partner);
      const groupContacts = groups.slice();
      if (group && !groupContacts.some((item) => item.id === group.id)) {
        groupContacts.unshift({ ...group, memberCount: conversation.members.length });
      }
      const messages = conversationType === "group" ? conversation?.messages || [] : conversation?.messages || [];
      pageView.innerHTML = `
        <h1 class="page-heading">Messages 💬</h1>
        <p class="page-description">Private messages and group chats.</p>
        <div class="card message-layout">
          <div class="message-contacts" aria-label="Conversations">
            <button class="primary-button group-chat-create" type="button" data-action="createGroupChat">New group chat</button>
            <p class="message-section-label">Direct messages</p>
            ${contacts.map((contact) => `
              <button class="message-contact ${conversationType === "direct" && contact.id === partner?.id ? "active" : ""}" type="button" data-message-contact-id="${escapeHTML(contact.id)}">
                <img class="avatar avatar-sm" src="${escapeHTML(contact.avatar || defaultAvatar)}" alt="">
                <span><strong>${escapeHTML(contact.name)}</strong><small>${escapeHTML(contact.lastMessage || "Start a conversation")}</small></span>
              </button>`).join("")}
            ${!contacts.length ? `<p class="page-description">No direct messages yet.</p>` : ""}
            <p class="message-section-label">Group chats</p>
            ${groupContacts.map((item) => `
              <button class="message-contact ${conversationType === "group" && item.id === group?.id ? "active" : ""}" type="button" data-group-chat-id="${escapeHTML(item.id)}">
                <span class="group-chat-avatar" aria-hidden="true">✦</span>
                <span><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.lastMessage || `${item.memberCount} members`)}</small></span>
              </button>`).join("")}
            ${!groupContacts.length ? `<p class="page-description">No group chats yet.</p>` : ""}
            <button class="secondary-button" type="button" data-action="people">Find people</button>
          </div>
          ${partner || group ? `<section class="message-chat" aria-label="${group ? "Group chat" : `Conversation with ${escapeHTML(partner.name)}`}">
            <header class="chat-heading">
              ${group ? `<span class="group-chat-avatar" aria-hidden="true">✦</span><span><strong>${escapeHTML(group.name)}</strong><small>${conversation.members.map((member) => `@${escapeHTML(member.username)}`).join(", ")}</small></span>` : `<img class="avatar avatar-sm" src="${escapeHTML(partner.avatar || defaultAvatar)}" alt=""><button class="author-name" type="button" data-open-profile="${escapeHTML(partner.id)}">${escapeHTML(partner.name)}</button>`}
            </header>
            <div class="chat-body">${messages.map((message) => `
              <div class="chat-message ${message.sender_id === userProfile.id ? "mine" : ""}">${group && message.sender_id !== userProfile.id ? `<strong>${escapeHTML(message.sender_name)}</strong>` : ""}<div class="chat-bubble ${message.sender_id === userProfile.id ? "mine" : ""}">${escapeHTML(message.body)}</div></div>`).join("")}</div>
            <form class="chat-form" id="chatForm">
              <input name="message" aria-label="Write a message" placeholder="Write a message..." maxlength="1000" required>
              <button class="primary-button" type="submit">Send</button>
            </form>
          </section>` : `<section class="message-chat"><p class="page-description">Select a conversation or find a student to send a message.</p></section>`}
        </div>`;
      const body = pageView.querySelector(".chat-body");
      if (body) body.scrollTop = body.scrollHeight;
    }

    function openGroupChatComposer() {
      selectedGroupMembers = new Map();
      openModal("Create a group chat", `
        <form id="groupChatForm">
          <label class="auth-field"><span>Group name</span><input name="name" maxlength="60" minlength="2" placeholder="Study group" required></label>
          <label class="auth-field"><span>Find people by username or name</span><input id="groupMemberSearch" type="search" autocomplete="off" placeholder="Search students..."></label>
          <div class="group-member-results" id="groupMemberResults"></div>
          <div class="group-selected-members" id="groupSelectedMembers"></div>
          <p class="page-description">Choose at least two other people for a group of three or more.</p>
          <button class="primary-button" type="submit">Create group</button>
        </form>`);
      modalCard.querySelector("#groupMemberSearch").focus();
    }

    function renderSelectedGroupMembers() {
      const container = modalCard.querySelector("#groupSelectedMembers");
      if (!container) return;
      container.innerHTML = [...selectedGroupMembers.entries()].map(([id, person]) => `
        <button class="group-member-chip" type="button" data-group-person-id="${escapeHTML(id)}" data-name="${escapeHTML(person.name)}" data-username="${escapeHTML(person.username)}">
          @${escapeHTML(person.username)} ×
        </button>`).join("");
    }

    async function showProfilePage(userId = userProfile.id) {
      currentPage = "Profile";
      activeCommunity = "";
      pageView.hidden = false;
      welcome.hidden = true;
      postForm.hidden = true;
      feedTabs.hidden = true;
      emptyState.style.display = "none";
      feed.querySelectorAll(".post").forEach((post) => { post.hidden = true; });
      pageView.innerHTML = `<h1 class="page-heading">Profile</h1><p class="page-description">Loading profile…</p>`;
      try {
        const [{ profile }, postsResult] = await Promise.all([
          apiRequest(`/api/people/${encodeURIComponent(userId)}`),
          apiRequest(`/api/posts?authorId=${encodeURIComponent(userId)}`)
        ]);
        const viewingOwn = profile.id === userProfile.id;
        renderProfilePage(profile, viewingOwn, postsResult.posts);
      } catch (error) {
        pageView.innerHTML = `<h1 class="page-heading">Profile</h1><p class="page-description">Could not load profile: ${escapeHTML(error.message)}</p>`;
      }
    }

    function renderProfilePage(profile, viewingOwn, posts) {
      const safeName = escapeHTML(profile.name);
      const safeUniversity = escapeHTML(profile.university || "");
      const safeMajor = escapeHTML(profile.major || "");
      const safeBio = escapeHTML(profile.bio || "");
      const safeAvatar = escapeHTML(profile.avatar || defaultAvatar);
      const safeBanner = profile.banner || "";
      const following = Boolean(profile.following);
      const heading = viewingOwn ? "Your profile 👋" : `${safeName}'s profile`;
      const description = viewingOwn
        ? "Update your profile and see the posts you have shared."
        : "Connect with this student and see what they have shared.";
      const profileContent = viewingOwn ? `
        <form class="card profile-card" id="profileForm">
          <div class="profile-details">
            <div class="profile-edit-avatar">
              <img class="avatar" src="${safeAvatar}" alt="${safeName} profile photo">
              <button class="secondary-button" type="button" data-action="profilePhoto">Change photo</button>
            </div>
            <div class="profile-cover"><button class="secondary-button banner-change-button" type="button" data-action="bannerPhoto">Change banner</button></div>
            <div class="profile-stats"><span><strong>${profile.followerCount}</strong> followers</span><span><strong>${profile.followingCount}</strong> following</span><span><strong>${profile.isPro ? "Pro" : "Free"}</strong> account</span></div>
            <div class="profile-fields">
              <label class="auth-field"><span>Full name</span><input name="name" value="${safeName}" maxlength="40" required></label>
              <label class="auth-field"><span>Username</span><input name="username" value="${escapeHTML(profile.username || "")}" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" required></label>
              <label class="auth-field"><span>University email</span><input type="email" value="${escapeHTML(userProfile.email)}" readonly></label>
              <label class="auth-field"><span>University</span><input name="university" value="${safeUniversity}" maxlength="70"></label>
              <label class="auth-field"><span>Major / course</span><input name="major" value="${safeMajor}" maxlength="70"></label>
              <label class="auth-field wide"><span>About you</span><textarea name="bio" maxlength="220" rows="3">${safeBio}</textarea></label>
            </div>
            <div class="profile-buttons">
              <button class="primary-button" type="submit">Save profile</button>
              <button class="secondary-button" type="button" data-action="signOut">Sign out</button>
            </div>
            <section class="pro-card">
              <h2>${profile.isPro ? "Ahder Pro is active" : "Upgrade to Ahder Pro"}</h2>
              <p>${profile.isPro ? "Your account has Pro status." : "Paid upgrades are coming soon. Billing is not configured yet."}</p>
              ${profile.isPro ? "" : `<button class="secondary-button" type="button" data-action="proUpgrade">Upgrade to Pro</button>`}
            </section>
          </div>
        </form>` : `
        <section class="card profile-card">
          <div class="profile-details">
            <div class="profile-edit-avatar"><img class="avatar" src="${safeAvatar}" alt="${safeName} profile photo"></div>
            <div class="profile-cover"></div>
            <h2>${safeName}${profile.isPro ? ` <span class="pro-badge">PRO</span>` : ""}</h2>
            <p class="page-description">@${escapeHTML(profile.username || "")}</p>
            <p class="page-description">${safeMajor}${safeMajor && safeUniversity ? " · " : ""}${safeUniversity}</p>
            <p>${safeBio || "This student hasn't added a bio yet."}</p>
            <div class="profile-stats"><span><strong data-profile-followers>${profile.followerCount}</strong> followers</span><span><strong>${profile.followingCount}</strong> following</span></div>
            <div class="profile-buttons">
              <span class="person-info"><strong>${safeName}</strong></span>
              <button class="follow-button ${following ? "following" : ""}" type="button" data-user-id="${escapeHTML(profile.id)}" aria-label="${following ? "Unfollow" : "Follow"} ${safeName}" aria-pressed="${following}">${following ? "✓" : "+"}</button>
              <button class="primary-button" type="button" data-message-user="${escapeHTML(profile.id)}">Message</button>
            </div>
          </div>
        </section>`;
      pageView.innerHTML = `<h1 class="page-heading">${heading}</h1><p class="page-description">${description}</p>${profileContent}<h2 class="page-heading profile-posts-heading">Posts</h2><div class="profile-post-list"></div>`;
      if (safeBanner) {
        pageView.querySelector(".profile-cover").style.backgroundImage = `linear-gradient(120deg, rgba(48, 39, 120, .35), rgba(82, 67, 190, .35)), url("${safeBanner}")`;
      }
      const postList = pageView.querySelector(".profile-post-list");
      if (!posts.length) {
        postList.innerHTML = `<p class="page-description">${viewingOwn ? "You haven't shared any posts yet." : "This student hasn't shared any posts yet."}</p>`;
        return;
      }
      posts.slice().reverse().forEach((serverPost) => {
        const media = serverPost.media_url ? { type: serverPost.media_type, src: serverPost.media_url } : null;
        const poll = Array.isArray(serverPost.poll_options) ? { options: serverPost.poll_options } : null;
        const post = createPost(serverPost.body, media, poll, serverPost, postList);
        post.dataset.serverPostId = serverPost.id;
      });
    }

    document.addEventListener("click", (event) => {
      const target = event.target.closest("[data-toast]");
      if (target) {
        event.preventDefault();
        showToast(target.dataset.toast);
      }

      const infoLink = event.target.closest("[data-info]");
      if (infoLink) {
        event.preventDefault();
        openInfo(infoLink.dataset.info);
      }

      const action = event.target.closest("[data-action]");
      if (action) {
        const actionName = action.dataset.action;
        if (actionName === "inviteFriends") {
          const shareData = {
            title: "Join me on Ahder",
            text: "Join me on Ahder to connect with our campus community.",
            url: window.location.origin
          };
          if (navigator.share) {
            navigator.share(shareData).catch((error) => {
              if (error.name !== "AbortError") openInviteLink(shareData.url);
            });
          } else if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(shareData.url)
              .then(() => showToast("Ahder link copied. Send it to your friends!"))
              .catch(() => openInviteLink(shareData.url));
          } else {
            openInviteLink(shareData.url);
          }
        } else if (actionName === "mobileMenu") {
          const rail = document.getElementById("leftRail");
          const isOpen = rail.classList.toggle("mobile-open");
          action.setAttribute("aria-expanded", String(isOpen));
          action.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
        } else if (actionName === "profile") {
          closeMobileNavigation();
          document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.nav === "Profile"));
          showProfilePage();
        } else if (actionName === "notifications") {
          openNotifications();
        } else if (actionName === "theme") {
          const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
          setTheme(nextTheme);
          writeStorage("ahder-theme-v1", nextTheme);
          showToast(`${nextTheme === "dark" ? "Dark" : "Light"} mode enabled.`);
        } else if (actionName === "people") {
          closeMobileNavigation();
          document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
          openPeoplePage();
        } else if (actionName === "proUpgrade") {
          apiRequest("/api/me/pro/checkout", { method: "POST" })
            .then(() => showToast("Pro billing is not configured yet."))
            .catch((error) => showToast(error.message));
        } else if (actionName === "profilePhoto") {
          document.getElementById("profilePhotoInput").click();
        } else if (actionName === "bannerPhoto") {
          document.getElementById("profileBannerInput").click();
        } else if (actionName === "photo") {
          document.getElementById("photoInput").click();
        } else if (actionName === "video") {
          document.getElementById("videoInput").click();
        } else if (actionName === "removePhoto") {
          if (pendingMedia && pendingMedia.type === "video") URL.revokeObjectURL(pendingMedia.src);
          pendingMedia = null;
          document.getElementById("pendingPhotoPreview").replaceChildren();
          document.getElementById("pendingPhotoPreview").hidden = true;
        } else if (actionName === "eventComposer") {
          openModal("Create a campus event", `
            <form id="eventComposerForm">
              <label class="auth-field"><span>Event name</span><input name="name" maxlength="70" placeholder="What are you planning?" required></label>
              <label class="auth-field"><span>Date</span><input name="date" type="date" required></label>
              <label class="auth-field"><span>Time</span><input name="time" type="time" required></label>
              <label class="auth-field"><span>Location</span><input name="place" maxlength="70" placeholder="Where on campus?" required></label>
              <button class="primary-button" type="submit">Share event</button>
            </form>`);
          const eventDateInput = modalCard.querySelector('input[name="date"]');
          const today = new Date();
          today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
          eventDateInput.min = today.toISOString().slice(0, 10);
        } else if (actionName === "pollComposer") {
          openModal("Create a quick poll", `
            <form id="pollComposerForm">
              <label class="auth-field"><span>Your question</span><input name="question" maxlength="140" placeholder="Ask your campus..." required></label>
              <label class="auth-field"><span>Option 1</span><input name="option1" maxlength="60" required></label>
              <label class="auth-field"><span>Option 2</span><input name="option2" maxlength="60" required></label>
              <label class="auth-field"><span>Option 3 (optional)</span><input name="option3" maxlength="60"></label>
              <button class="primary-button" type="submit">Post poll</button>
            </form>`);
        } else if (actionName === "comment") {
          openComments(action.closest(".post"));
        } else if (actionName === "postMenu") {
          currentPostMenu = action.closest(".post");
          const canDelete = currentPostMenu.dataset.serverPostId
            && currentPostMenu.dataset.authorId === userProfile.id;
          openModal("Post options", `
            <div class="toast-stack">
              <button class="notification-item" type="button" data-post-choice="save"><span class="notification-icon">🔖</span><span class="person-info"><strong>${currentPostMenu.dataset.saved === "true" ? "Remove from saved" : "Save post"}</strong><small>Keep this post handy for later</small></span></button>
              <button class="notification-item" type="button" data-post-choice="share"><span class="notification-icon">↗</span><span class="person-info"><strong>Copy post link</strong><small>Share this post with a friend</small></span></button>
              ${canDelete ? `<button class="notification-item delete-post-choice" type="button" data-post-choice="delete"><span class="notification-icon">🗑</span><span class="person-info"><strong>Delete post</strong><small>Remove this post from Ahder</small></span></button>` : ""}
              <button class="notification-item" type="button" data-post-choice="report"><span class="notification-icon">⚑</span><span class="person-info"><strong>Report post</strong><small>Tell us if something feels wrong</small></span></button>
            </div>`);
        } else if (actionName === "signOut") {
          signOut();
        }
      }

      const closeButton = event.target.closest("[data-close-modal]");
      if (closeButton) closeModal();

      if (event.target.closest("[data-copy-invite]")) {
        const inviteInput = modalCard.querySelector("#inviteLink");
        inviteInput.select();
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(inviteInput.value)
            .then(() => {
              closeModal();
              showToast("Ahder link copied. Send it to your friends!");
            })
            .catch(() => showToast("Select and copy the Ahder link to send it to your friends."));
        } else {
          showToast("Select and copy the Ahder link to send it to your friends.");
        }
      }

      const postChoice = event.target.closest("[data-post-choice]");
      if (postChoice && currentPostMenu) {
        const choice = postChoice.dataset.postChoice;
        if (choice === "save") {
          const saveButton = currentPostMenu.querySelector(".save-button");
          if (saveButton) saveButton.click();
          closeModal();
        } else if (choice === "delete") {
          if (currentPostMenu.dataset.authorId === userProfile.id) {
            closeModal();
            openModal("Delete this post?", `
              <p class="page-description">This permanently removes your post and its comments. This can't be undone.</p>
              <div class="profile-buttons">
                <button class="primary-button" type="button" data-confirm-delete>Delete post</button>
                <button class="secondary-button" type="button" data-close-modal>Cancel</button>
              </div>`);
          }
        } else if (choice === "report") {
          currentPostMenu.dataset.reported = "true";
          closeModal();
          showToast("Thanks for letting us know. This post has been flagged in your demo.");
        } else {
          const shareLink = `${window.location.href.split("#")[0]}#${currentPostMenu.dataset.postId || "campus-post"}`;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareLink).then(() => showToast("Post link copied to your clipboard.")).catch((error) => showToast(`Could not copy the link: ${error.message}`));
            closeModal();
          } else {
            openModal("Share this post", `<label class="auth-field"><span>Copy this link</span><input value="${escapeHTML(shareLink)}" readonly></label><p class="page-description">Select the link above and copy it to share this post.</p>`);
          }
        }
      }

      if (event.target.closest("[data-confirm-delete]") && currentPostMenu) {
        void deletePost(currentPostMenu);
      }

      const notification = event.target.closest("[data-notification]");
      if (notification) {
        const item = notificationItems[Number(notification.dataset.notification)];
        closeModal();
        if (item) {
          if (item.page === "Events") showEventsPage();
          else if (item.page === "Home") showFeedPage("Home");
          else showFeedPage("Community", item.page);
          showToast(`Opened ${item.page}.`);
        }
      }

      if (event.target.closest("[data-clear-notifications]")) {
        notificationItems = [];
        closeModal();
        showToast("All notifications marked as read.");
      }

      const pollOption = event.target.closest("[data-poll-option]");
      if (pollOption) {
        const poll = pollOption.closest(".poll-card");
        const post = pollOption.closest(".post");
        if (post.dataset.voted === "true") return;
        const votes = JSON.parse(poll.dataset.votes);
        const optionIndex = Number(pollOption.dataset.pollOption);
        if (post.dataset.serverPostId) {
          apiRequest(`/api/posts/${encodeURIComponent(post.dataset.serverPostId)}/vote`, {
            method: "POST",
            body: JSON.stringify({ optionIndex })
          }).then((result) => {
            result.votes.forEach((vote) => { votes[Number(vote.option_index)] = Number(vote.count); });
            showPollResults(poll, votes);
            post.dataset.voted = "true";
          }).catch((error) => showToast(`Could not save your vote: ${error.message}`));
          return;
        }
        votes[optionIndex]++;
        poll.dataset.votes = JSON.stringify(votes);
        showPollResults(poll, votes);
        post.dataset.voted = "true";
      }

      if (event.target === modalBackdrop) closeModal();

      const hashtag = event.target.closest("[data-hashtag]");
      if (hashtag) {
        event.preventDefault();
        searchInput.value = hashtag.dataset.hashtag;
        searchInput.dispatchEvent(new Event("input"));
      }

      const link = event.target.closest("[data-nav]");
      if (link) {
        event.preventDefault();
        closeMobileNavigation();
        document.querySelectorAll(".nav-link").forEach((item) => {
          item.classList.toggle("active", item.dataset.nav === link.dataset.nav);
        });
        currentFeedTab = "For you";
        searchInput.value = "";
        activeCommunity = "";
        if (link.dataset.nav === "Messages") showMessagesPage();
        else if (link.dataset.nav === "Events") showEventsPage();
        else if (link.dataset.nav === "Profile") showProfilePage();
        else showFeedPage(link.dataset.nav);
      }

      const group = event.target.closest("[data-community]");
      if (group) {
        event.preventDefault();
        closeMobileNavigation();
        document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
        searchInput.value = "";
        showFeedPage("Community", group.dataset.community);
      }

      const eventLink = event.target.closest("[data-event]");
      if (eventLink) {
        event.preventDefault();
        document.querySelectorAll(".nav-link").forEach((item) => {
          item.classList.toggle("active", item.dataset.nav === "Events");
        });
        showEventsPage();
      }

      const trend = event.target.closest("[data-trend]");
      if (trend) {
        event.preventDefault();
        closeMobileNavigation();
        document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.nav === "Explore"));
        showFeedPage("Explore");
        searchInput.value = trend.dataset.trend;
        searchInput.dispatchEvent(new Event("input"));
      }

      const rsvp = event.target.closest("[data-rsvp]");
      if (rsvp) {
        const joined = rsvp.getAttribute("aria-pressed") === "true";
        const eventIndex = Number(rsvp.dataset.rsvp);
        if (joined) attendingEvents.delete(eventIndex);
        else attendingEvents.add(eventIndex);
        writeStorage("ahder-attending-events-v1", [...attendingEvents]);
        rsvp.setAttribute("aria-pressed", String(!joined));
        rsvp.classList.toggle("joined", !joined);
        rsvp.textContent = joined ? "I'm going" : "Going ✓";
      }

      const remoteRsvp = event.target.closest("[data-rsvp-id]");
      if (remoteRsvp) {
        const button = remoteRsvp;
        const joined = button.getAttribute("aria-pressed") === "true";
        apiRequest(`/api/events/${encodeURIComponent(button.dataset.rsvpId)}/rsvp`, { method: "POST" })
          .then((result) => {
            button.setAttribute("aria-pressed", String(result.attending));
            button.classList.toggle("joined", result.attending);
            button.innerHTML = `${result.attending ? "Going ✓" : "I'm going"} <small>${result.count}</small>`;
          })
          .catch((error) => {
            button.setAttribute("aria-pressed", String(joined));
            showToast(`Could not update your RSVP: ${error.message}`);
          });
      }

      const messageContact = event.target.closest("[data-message-contact-id]");
      if (messageContact) showMessagesPage(messageContact.dataset.messageContactId, "direct");

      const groupContact = event.target.closest("[data-group-chat-id]");
      if (groupContact) showMessagesPage(groupContact.dataset.groupChatId, "group");

      const groupPerson = event.target.closest("[data-group-person-id]");
      if (groupPerson && selectedGroupMembers) {
        const memberId = groupPerson.dataset.groupPersonId;
        if (selectedGroupMembers.has(memberId)) selectedGroupMembers.delete(memberId);
        else selectedGroupMembers.set(memberId, {
          name: groupPerson.dataset.name,
          username: groupPerson.dataset.username
        });
        renderSelectedGroupMembers();
        modalCard.querySelectorAll(".group-member-option").forEach((option) => {
          option.classList.toggle("selected", selectedGroupMembers.has(option.dataset.groupPersonId));
        });
      }

      if (event.target.closest('[data-action="createGroupChat"]')) openGroupChatComposer();

      const likeButton = event.target.closest(".like-button");
      if (likeButton) {
        const button = likeButton;
        const liked = button.getAttribute("aria-pressed") === "true";
        const post = button.closest(".post");
        const count = post.querySelector(".like-count");
        const previousCount = Number(count.textContent);
        count.textContent = previousCount + (liked ? -1 : 1);
        button.setAttribute("aria-pressed", String(!liked));
        button.classList.toggle("liked", !liked);
        if (post.dataset.serverPostId) {
          apiRequest(`/api/posts/${encodeURIComponent(post.dataset.serverPostId)}/like`, { method: "POST" })
            .then((result) => {
              count.textContent = String(result.count);
              button.setAttribute("aria-pressed", String(result.liked));
              button.classList.toggle("liked", result.liked);
            })
            .catch((error) => {
              count.textContent = String(previousCount);
              button.setAttribute("aria-pressed", String(liked));
              button.classList.toggle("liked", liked);
              showToast(`Could not update reaction: ${error.message}`);
            });
        }
      }

      const saveButton = event.target.closest(".save-button");
      if (saveButton) {
        const button = saveButton;
        const saved = button.getAttribute("aria-pressed") === "true";
        button.setAttribute("aria-pressed", String(!saved));
        button.classList.toggle("liked", !saved);
        const post = button.closest(".post");
        post.dataset.saved = String(!saved);
        if (post.dataset.serverPostId) {
          apiRequest(`/api/posts/${encodeURIComponent(post.dataset.serverPostId)}/save`, { method: "POST" })
            .then((result) => {
              post.dataset.saved = String(result.saved);
              button.setAttribute("aria-pressed", String(result.saved));
              button.classList.toggle("liked", result.saved);
              if (currentPage === "Saved") refreshRemotePosts(true).catch((error) => showToast(error.message));
            })
            .catch((error) => {
              post.dataset.saved = String(saved);
              button.setAttribute("aria-pressed", String(saved));
              button.classList.toggle("liked", saved);
              showToast(`Could not save this post: ${error.message}`);
            });
        } else if (post.dataset.postId) {
          if (saved) savedPostIds.delete(post.dataset.postId);
          else savedPostIds.add(post.dataset.postId);
          writeStorage(savedStorageKey, [...savedPostIds]);
        }
        if (currentPage === "Saved") updatePosts();
        showToast(saved ? "Post removed from your saved items." : "Post saved for later.");
      }

      const followButton = event.target.closest(".follow-button");
      if (followButton) {
        const button = followButton;
        const following = button.getAttribute("aria-pressed") === "true";
        button.setAttribute("aria-pressed", String(!following));
        button.classList.toggle("following", !following);
        button.textContent = following ? "+" : "✓";
        const personName = button.previousElementSibling.querySelector("strong").textContent;
        button.setAttribute("aria-label", `${following ? "Follow" : "Unfollow"} ${personName}`);
        if (button.dataset.userId) {
          apiRequest(`/api/people/${encodeURIComponent(button.dataset.userId)}/follow`, { method: "POST" })
            .then((result) => {
              button.setAttribute("aria-pressed", String(result.following));
              button.classList.toggle("following", result.following);
              button.textContent = result.following ? "✓" : "+";
              button.setAttribute("aria-label", `${result.following ? "Unfollow" : "Follow"} ${personName}`);
              if (result.following) followingPeople.add(personName);
              else followingPeople.delete(personName);
              const followerCount = pageView.querySelector("[data-profile-followers]");
              if (followerCount) {
                followerCount.textContent = String(Number(followerCount.textContent) + (result.following ? 1 : -1));
              }
              if (currentFeedTab === "Following") updatePosts();
            })
            .catch((error) => showToast(`Could not update follow: ${error.message}`));
        } else {
          if (following) followingPeople.delete(personName);
          else followingPeople.add(personName);
          writeStorage("ahder-following-v1", [...followingPeople]);
        }
        if (currentFeedTab === "Following") updatePosts();
      }

      const profileLink = event.target.closest("[data-open-profile]");
      if (profileLink) {
        event.preventDefault();
        document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.nav === "Profile"));
        showProfilePage(profileLink.dataset.openProfile);
      }

      const messageLink = event.target.closest("[data-message-user]");
      if (messageLink) {
        event.preventDefault();
        document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item.dataset.nav === "Messages"));
        showMessagesPage(messageLink.dataset.messageUser, "direct");
      }
      if (event.target.closest("[data-nav]")) closeMobileNavigation();
      if (event.target === modalBackdrop) closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMobileNavigation();
        if (!modalBackdrop.hidden) closeModal();
      }
    });

    document.querySelectorAll(".feed-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        currentFeedTab = tab.dataset.feedTab;
        document.querySelectorAll(".feed-tab").forEach((item) => {
          item.classList.toggle("active", item === tab);
          item.setAttribute("aria-selected", String(item === tab));
        });
        if (currentFeedTab === "Following") {
          refreshRemotePosts(false, true).catch((error) => showToast(`Could not load your following feed: ${error.message}`));
        } else {
          refreshRemotePosts(false).catch((error) => showToast(`Could not load campus posts: ${error.message}`));
        }
      });
    });

    const searchInput = document.getElementById("searchInput");
    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      closeMobileNavigation();
      openPeoplePage();
    });
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.trim().toLowerCase().replace(/^#/, "");
      if (currentPage === "Events") {
        const eventCards = pageView.querySelectorAll(".event-page-card");
        let visible = 0;
        eventCards.forEach((card) => {
          card.hidden = Boolean(query) && !card.textContent.toLowerCase().includes(query);
          if (!card.hidden) visible++;
        });
        let message = pageView.querySelector(".event-empty");
        if (!visible && !message) {
          message = document.createElement("p");
          message.className = "page-description event-empty";
          message.textContent = "No events match that search.";
          pageView.append(message);
        } else if (visible && message) {
          message.remove();
        }
      } else if (currentPage === "Messages") {
        pageView.querySelectorAll(".message-contact").forEach((contact) => {
          contact.hidden = Boolean(query) && !contact.textContent.toLowerCase().includes(query);
        });
      } else if (currentPage === "People") {
        openPeoplePage();
      } else if (currentPage !== "Profile") {
        if (currentPage === "Home" && query) {
          currentPage = "Explore";
          welcomeTitle.textContent = "Explore your campus 🌎";
          welcomeDescription.textContent = "Find posts, people, and ideas from your university.";
        }
        updatePosts();
      }
    });

    pageView.addEventListener("submit", async (event) => {
      if (event.target.id === "chatForm") {
        event.preventDefault();
        const input = event.target.elements.message;
        const message = input.value.trim();
        if (!message || !activeConversationId) return;
        try {
          const endpoint = activeConversationType === "group"
            ? `/api/groups/${encodeURIComponent(activeConversationId)}/messages`
            : `/api/messages/${encodeURIComponent(activeConversationId)}`;
          await apiRequest(endpoint, {
            method: "POST",
            body: JSON.stringify({ body: message })
          });
          await showMessagesPage(activeConversationId, activeConversationType);
        } catch (error) {
          showToast(`Could not send your message: ${error.message}`);
        }
      }
      if (event.target.id === "profileForm") {
        event.preventDefault();
        const data = new FormData(event.target);
        try {
          const result = await apiRequest("/api/me", {
            method: "PATCH",
            body: JSON.stringify({
              name: String(data.get("name")).trim(),
              username: String(data.get("username")).trim().toLowerCase(),
              university: String(data.get("university")).trim(),
              major: String(data.get("major")).trim(),
              bio: String(data.get("bio")).trim()
            })
          });
          userProfile = { ...userProfile, ...result.user };
          applyProfile();
          showProfilePage();
          showToast("Your profile has been saved to your Ahder account.");
        } catch (error) {
          showToast(`Could not save profile: ${error.message}`);
        }
      }
    });

    modalCard.addEventListener("input", async (event) => {
      if (event.target.id !== "groupMemberSearch") return;
      const query = event.target.value.trim();
      const results = modalCard.querySelector("#groupMemberResults");
      if (!results) return;
      if (!query) {
        results.replaceChildren();
        return;
      }
      try {
        const response = await apiRequest(`/api/people?q=${encodeURIComponent(query)}`);
        results.innerHTML = response.people.map((person) => `
          <button class="group-member-option ${selectedGroupMembers.has(person.id) ? "selected" : ""}" type="button"
            data-group-person-id="${escapeHTML(person.id)}" data-name="${escapeHTML(person.name)}" data-username="${escapeHTML(person.username)}">
            <img class="avatar avatar-sm" src="${escapeHTML(person.avatar_url || defaultAvatar)}" alt="">
            <span><strong>${escapeHTML(person.name)}</strong><small>@${escapeHTML(person.username)}</small></span>
          </button>`).join("") || `<p class="page-description">No matching students found.</p>`;
      } catch (error) {
        results.innerHTML = `<p class="page-description">Could not search students: ${escapeHTML(error.message)}</p>`;
      }
    });

    modalCard.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.target.id === "commentForm" && activePost) {
        const text = String(new FormData(event.target).get("comment")).trim();
        if (!text) return;
        try {
          if (activePost.dataset.serverPostId) {
            await apiRequest(`/api/posts/${encodeURIComponent(activePost.dataset.serverPostId)}/comments`, {
              method: "POST",
              body: JSON.stringify({ body: text })
            });
            const result = await apiRequest(`/api/posts/${encodeURIComponent(activePost.dataset.serverPostId)}/comments`);
            activePost.dataset.comments = JSON.stringify(result.comments);
            activePost.querySelector(".comment-count").textContent = `${result.comments.length} ${result.comments.length === 1 ? "comment" : "comments"}`;
            showComments(activePost, result.comments);
          } else {
            const comments = JSON.parse(activePost.dataset.comments || "[]");
            comments.push({ name: userProfile.name, text });
            activePost.dataset.comments = JSON.stringify(comments);
            activePost.querySelector(".comment-count").textContent = `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
            closeModal();
          }
          showToast("Your comment was added.");
        } catch (error) {
          showToast(`Could not add comment: ${error.message}`);
        }
      } else if (event.target.id === "groupChatForm") {
        const name = String(new FormData(event.target).get("name")).trim();
        if (selectedGroupMembers.size < 2) {
          showToast("Select at least two people to create a group chat.");
          return;
        }
        try {
          const result = await apiRequest("/api/groups", {
            method: "POST",
            body: JSON.stringify({ name, memberIds: [...selectedGroupMembers.keys()] })
          });
          selectedGroupMembers = null;
          closeModal();
          await showMessagesPage(result.group.id, "group");
          showToast("Your group chat is ready.");
        } catch (error) {
          showToast(`Could not create group chat: ${error.message}`);
        }
      } else if (event.target.id === "pollComposerForm") {
        const data = new FormData(event.target);
        const options = [data.get("option1"), data.get("option2"), data.get("option3")]
          .map((option) => String(option || "").trim()).filter(Boolean);
        const question = String(data.get("question")).trim();
        try {
          const post = await publishRemotePost(question, null, options);
          closeModal();
          post.scrollIntoView({ behavior: "smooth", block: "center" });
          showToast("Your poll is live on campus!");
        } catch (error) {
          showToast(`Could not post poll: ${error.message}`);
        }
      } else if (event.target.id === "eventComposerForm") {
        const data = new FormData(event.target);
        const name = String(data.get("name")).trim();
        try {
          await apiRequest("/api/events", {
            method: "POST",
            body: JSON.stringify({
              name,
              date: String(data.get("date")),
              time: String(data.get("time")),
              place: String(data.get("place")).trim()
            })
          });
          closeModal();
          showEventsPage();
          showToast("Your event was shared with campus!");
        } catch (error) {
          showToast(`Could not create event: ${error.message}`);
        }
      }
    });

    document.getElementById("postForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const textarea = document.getElementById("postText");
      const text = textarea.value.trim();
      if (!text && !pendingMedia) {
        textarea.focus();
        showToast("Write a post or add a photo or video before sharing.");
        return;
      }

      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      let post;
      try {
        post = await publishRemotePost(text, pendingMedia);
      } catch (error) {
        showToast(`Could not publish your post: ${error.message}`);
        submitButton.disabled = false;
        return;
      }
      textarea.value = "";
      if (pendingMedia?.type === "video") URL.revokeObjectURL(pendingMedia.src);
      pendingMedia = null;
      document.getElementById("pendingPhotoPreview").replaceChildren();
      document.getElementById("pendingPhotoPreview").hidden = true;
      searchInput.value = "";
      submitButton.disabled = false;
      post.scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("Your post is live on campus!");
    });

    document.getElementById("photoInput").addEventListener("change", (event) => {
      loadPostMedia(event.target.files[0], (media) => {
        if (pendingMedia && pendingMedia.type === "video") URL.revokeObjectURL(pendingMedia.src);
        pendingMedia = media;
        const preview = document.getElementById("pendingPhotoPreview");
        preview.replaceChildren();
        const previewMedia = media.type === "video" ? document.createElement("video") : document.createElement("img");
        previewMedia.src = media.src;
        if (media.type === "video") {
          previewMedia.controls = true;
          previewMedia.muted = true;
          previewMedia.playsInline = true;
          previewMedia.preload = "metadata";
          previewMedia.setAttribute("aria-label", "Video post preview");
        } else {
          previewMedia.alt = "Post image preview";
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove attached media");
        remove.dataset.action = "removePhoto";
        preview.append(previewMedia, remove);
        preview.hidden = false;
      });
      event.target.value = "";
    });

    document.getElementById("videoInput").addEventListener("change", (event) => {
      loadPostMedia(event.target.files[0], (media) => {
        if (pendingMedia && pendingMedia.type === "video") URL.revokeObjectURL(pendingMedia.src);
        pendingMedia = media;
        const preview = document.getElementById("pendingPhotoPreview");
        preview.replaceChildren();
        const video = document.createElement("video");
        video.className = "post-video";
        video.src = media.src;
        video.controls = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.setAttribute("aria-label", `Video preview: ${media.name}`);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove attached media");
        remove.dataset.action = "removePhoto";
        preview.append(video, remove);
        preview.hidden = false;
      });
      event.target.value = "";
    });

    document.getElementById("profilePhotoInput").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) {
        const formData = new FormData();
        formData.append("avatar", file);
        apiRequest("/api/me/avatar", { method: "POST", body: formData }).then((result) => {
          userProfile = { ...userProfile, ...result.user };
          applyProfile();
          showProfilePage();
          showToast("Profile photo updated.");
        }).catch((error) => showToast(`Could not update profile photo: ${error.message}`));
      }
      event.target.value = "";
    });

    document.getElementById("profileBannerInput").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) {
        if (!file.type.startsWith("image/")) {
          showToast("Choose an image file for your banner.");
        } else if (file.size > 8 * 1024 * 1024) {
          showToast("Choose a banner image smaller than 8 MB.");
        } else {
          const formData = new FormData();
          formData.append("banner", file);
          apiRequest("/api/me/banner", { method: "POST", body: formData }).then((result) => {
            userProfile = { ...userProfile, ...result.user };
            const cover = pageView.querySelector(".profile-cover");
            if (cover && userProfile.banner) {
              cover.style.backgroundImage = `linear-gradient(120deg, rgba(48, 39, 120, .35), rgba(82, 67, 190, .35)), url("${userProfile.banner}")`;
            }
            showToast("Profile banner updated.");
          }).catch((error) => showToast(`Could not update profile banner: ${error.message}`));
        }
      }
      event.target.value = "";
    });

    const backToTop = document.getElementById("backToTop");
    backToTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    window.addEventListener("scroll", () => {
      backToTop.classList.toggle("visible", window.scrollY > 500);
    }, { passive: true });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modalBackdrop.hidden) closeModal();

      if ((event.key === "/" || (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)))
        && !event.altKey && !event.shiftKey && modalBackdrop.hidden
        && !authScreen.hidden && !event.target.matches("input, textarea, select, [contenteditable='true']")) {
        event.preventDefault();
        searchInput.focus();
      }

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)
        && !authScreen.hidden && !postForm.hidden && document.activeElement === document.getElementById("postText")) {
        event.preventDefault();
        postForm.requestSubmit();
      }
    });

    void initializeBackend();
