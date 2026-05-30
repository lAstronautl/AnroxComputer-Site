# frozen_string_literal: true

# Let Markdown files in `_posts` work without a `YYYY-MM-DD-` filename prefix.
# If an undated post has no front matter `date`, use the file modification time.
module Jekyll
  class PostReader
    def read_posts(dir)
      read_content(dir, "_posts", Document::DATELESS_FILENAME_MATCHER)
        .tap { |docs| docs.each(&:read) }
        .tap { |docs| docs.each { |doc| set_dateless_post_date(doc) } }
        .select { |doc| processable?(doc) }
    end

    private

    def set_dateless_post_date(doc)
      return if doc.relative_path.match?(Document::DATE_FILENAME_MATCHER)
      return if doc.data.key?("date")

      doc.data["date"] = doc.source_file_mtime
    end
  end
end
